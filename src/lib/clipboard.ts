import type { ReactNode } from 'react'

/**
 * Put text on the system clipboard.
 *
 * Prefer the main-process bridge: Chromium's Clipboard API is denied by our
 * default permission handlers, so navigator.clipboard.writeText fails silently
 * in this app without an allow-list or a main write.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof window !== 'undefined' && window.gronk?.writeClipboard) {
    await window.gronk.writeClipboard(text)
    return
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Last resort for non-Electron test hosts.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy command failed')
  } finally {
    document.body.removeChild(ta)
  }
}

/** Flatten react-markdown code children into plain text for Copy. */
export function codeChildrenToText(children: ReactNode): string {
  return flatten(children).replace(/\n$/, '')
}

function flatten(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const el = node as { props?: { children?: ReactNode } }
    return flatten(el.props?.children)
  }
  return ''
}
