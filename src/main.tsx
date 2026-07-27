import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const rootEl = document.getElementById('root')

/**
 * Built as nodes rather than an HTML string. `message` is an error text, and
 * interpolating it into innerHTML parses whatever it contains as markup — on the
 * one code path that runs when the app is already too broken to have loaded its
 * defences. textContent cannot execute anything.
 */
function bootError(message: string): void {
  if (!rootEl) return
  const wrap = document.createElement('div')
  wrap.setAttribute(
    'style',
    'padding:24px;font-family:system-ui;color:#f2f2f2;background:#000;min-height:100vh'
  )

  const heading = document.createElement('h2')
  heading.setAttribute('style', 'color:#ff4d00')
  heading.textContent = 'Gronk failed to start'

  const detail = document.createElement('pre')
  detail.setAttribute('style', 'white-space:pre-wrap;color:#a3a3a3')
  detail.textContent = message

  wrap.append(heading, detail)
  rootEl.replaceChildren(wrap)
}

try {
  if (!rootEl) throw new Error('Missing #root element')
  if (typeof window.gronk === 'undefined') {
    throw new Error(
      'window.gronk is missing — preload did not load. Check Electron sandbox / preload path.'
    )
  }
  // Expose OS so CSS can reserve space for the Windows title-bar overlay controls
  document.documentElement.dataset.platform = window.gronk.platform
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  bootError(msg)
}
