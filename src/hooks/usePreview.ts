import { useCallback, useEffect, useState } from 'react'
import type { MainToRendererEvent } from '../../shared/types'

/**
 * The dev-server preview pane.
 *
 * Owns its own `onEvent` subscription. `onEvent` supports any number of
 * independent subscribers and hands back an unsubscribe function, and
 * `preview-status` is the only event that touches this state — so routing it
 * through the composer's handler would only have coupled the two. The
 * subscription is torn down on unmount; skipping that would leave a dead handler
 * behind and fire every later preview update twice.
 */
export function usePreview(cwd: string | null) {
  const [previewRunning, setPreviewRunning] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    return window.gronk.onEvent((event: MainToRendererEvent) => {
      // `preview-log` is deliberately ignored, as it was before the split.
      if (event.type !== 'preview-status') return
      setPreviewRunning(event.running)
      setPreviewUrl(event.url)
      setPreviewError(event.error || null)
    })
  }, [])

  const startPreview = useCallback(async () => {
    if (!cwd) return
    setPreviewError(null)
    const s = await window.gronk.getSettings()
    const res = await window.gronk.previewStart(cwd, s.previewCommand)
    if (!res.ok) setPreviewError(res.message)
  }, [cwd])

  const stopPreview = useCallback(async () => {
    await window.gronk.previewStop()
  }, [])

  const togglePreview = useCallback(() => {
    if (previewRunning) void stopPreview()
    else void startPreview()
  }, [previewRunning, startPreview, stopPreview])

  return {
    previewRunning,
    previewUrl,
    previewError,
    startPreview,
    stopPreview,
    togglePreview
  }
}
