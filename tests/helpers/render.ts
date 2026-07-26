/**
 * Minimal React renderer for `node --test`, backed by jsdom.
 *
 * Deliberately not @testing-library: this needs to mount a component, flush
 * effects, and read the DOM. That is roughly forty lines, and the alternative is
 * a dependency tree larger than the app's entire runtime.
 */
import { createRequire } from 'node:module'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import type { JSDOM as JSDOMInstance } from 'jsdom'

/**
 * jsdom is require()d, not imported, and that is load-bearing.
 *
 * Node 22 mislinks CommonJS that is reached through the ESM loader whenever any
 * `load` hook is registered — and ts-loader.mjs must register one to compile
 * .tsx. With a hook present, Node materialises jsdom's source instead of handing
 * it to the classic CJS loader, which puts it on an async ModuleJob whose
 * runSync() runs before linking finishes. The first ESM-only package jsdom pulls
 * in then dies with `ERR_VM_MODULE_LINK_FAILURE: request for './fallback/
 * encoding.js' is not in cache`. A resolve-only hook is fine; a bare
 * pass-through `load` hook is enough to trigger it.
 *
 * createRequire keeps jsdom on the CJS loader, which links synchronously. Node
 * 22.22.3 and 24.8.0 fix the underlying bug, but the project's documented floor
 * is 22.18, so the suite has to pass there.
 */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as typeof import('jsdom')

export interface Mounted {
  container: HTMLElement
  /** Re-render with new children and flush effects. */
  rerender: (element: ReactElement) => Promise<void>
  unmount: () => void
  text: () => string
  query: (selector: string) => Element | null
  queryAll: (selector: string) => Element[]
  /** Click an element and flush whatever it triggered. */
  click: (target: Element) => Promise<void>
}

let dom: JSDOMInstance | null = null

/**
 * jsdom is installed onto globalThis once per process. React reads `window` and
 * `document` at module scope, so a fresh DOM per test would leave React bound to
 * a stale one.
 */
export function ensureDom(): JSDOMInstance {
  if (dom) return dom
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
  })
  // Node 22 defines some of these itself as getter-only, so a plain assignment
  // throws. defineProperty replaces them regardless of how they were declared.
  const install = (name: string, value: unknown) => {
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    } catch {
      /* a global we cannot replace is one React will read from window anyway */
    }
  }
  install('window', dom.window)
  install('document', dom.window.document)
  install('navigator', dom.window.navigator)
  install('HTMLElement', dom.window.HTMLElement)
  install('Element', dom.window.Element)
  install('Node', dom.window.Node)
  install('getComputedStyle', dom.window.getComputedStyle)
  install('requestAnimationFrame', (cb: FrameRequestCallback) => dom!.window.setTimeout(() => cb(Date.now()), 0))
  install('cancelAnimationFrame', (id: number) => dom!.window.clearTimeout(id))
  return dom
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const window = ensureDom().window
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)

  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(element)
  })

  return {
    container,
    rerender: async (next) => {
      await act(async () => {
        root.render(next)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
    text: () => container.textContent ?? '',
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => [...container.querySelectorAll(selector)],
    click: async (target) => {
      await act(async () => {
        target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }
  }
}

/** Let queued promises and effects settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
