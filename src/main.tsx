import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const rootEl = document.getElementById('root')

function bootError(message: string): void {
  if (!rootEl) return
  rootEl.innerHTML = `<div style="padding:24px;font-family:system-ui;color:#f2f2f2;background:#000;min-height:100vh">
    <h2 style="color:#ff4d00">Grocky failed to start</h2>
    <pre style="white-space:pre-wrap;color:#a3a3a3">${message}</pre>
  </div>`
}

try {
  if (!rootEl) throw new Error('Missing #root element')
  if (typeof window.grocky === 'undefined') {
    throw new Error(
      'window.grocky is missing — preload did not load. Check Electron sandbox / preload path.'
    )
  }
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  bootError(msg)
}
