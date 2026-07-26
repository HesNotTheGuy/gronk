import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const rootEl = document.getElementById('root')

function bootError(message: string): void {
  if (!rootEl) return
  rootEl.innerHTML = `<div style="padding:24px;font-family:system-ui;color:#f2f2f2;background:#000;min-height:100vh">
    <h2 style="color:#ff4d00">Gronk failed to start</h2>
    <pre style="white-space:pre-wrap;color:#a3a3a3">${message}</pre>
  </div>`
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
