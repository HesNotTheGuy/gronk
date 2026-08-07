import { useCallback, useState } from 'react'

/** Last transcript written to disk: drives the "saved to…" banner. */
interface ExportNotice {
  path: string
  format: 'md' | 'json'
  /** Main refuses to reveal paths outside its allowed roots; show why inline */
  revealError?: string
  /** Path is on the clipboard: the banner swaps its label to confirm */
  copied?: boolean
  /** Clipboard write refused (no permission / not focused); tell the user */
  copyError?: string
}

/**
 * Transcript export and the banner that reports where the file went.
 *
 * Failures land on the app-wide error line because that is where an export
 * failure was always reported. The two callbacks are that line's `export`-scoped
 * half, from `useGronk`: `beginExport` retires the last export failure,
 * `failExport` posts a new one. Both must be stable: they sit in the dependency
 * array below.
 *
 * Taking them rather than the raw `setError` dispatch is what stops this hook
 * from wiping an unrelated agent error, and what makes a successful export
 * take the previous export's failure down. Exporting one session with nothing
 * in it and then exporting another that works used to leave both banners up,
 * contradicting each other.
 */
export function useExportNotice(beginExport: () => void, failExport: (message: string) => void) {
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)

  const exportSession = useCallback(
    async (id: string, format: 'md' | 'json' = 'md') => {
      // A new export supersedes whatever the last one said, including the
      // cancel path: the previous complaint was about a different attempt.
      beginExport()
      try {
        const result = await window.gronk.exportTranscript(id, format)
        if (!result.ok) {
          // A cancel is the user's own choice, so stay silent. An empty
          // transcript is not, and would otherwise read as a dead menu item.
          if (result.reason === 'empty') {
            failExport('Nothing to export yet. This session has no saved transcript.')
          }
          return
        }
        setExportNotice({ path: result.path, format })
      } catch (err) {
        failExport(err instanceof Error ? err.message : String(err))
      }
    },
    [beginExport, failExport]
  )

  const revealExport = useCallback(async () => {
    if (!exportNotice) return
    const res = await window.gronk.revealLocalPath(exportNotice.path)
    // Keep the notice up either way: the path itself is the answer to "where?"
    setExportNotice((prev) =>
      prev
        ? {
            ...prev,
            revealError: res.ok ? undefined : res.error || 'Could not open the folder'
          }
        : prev
    )
  }, [exportNotice])

  /**
   * Reveal is gated on main's allowed roots and the save dialog defaults to
   * Documents, which is outside them, so copying the path is the action the
   * banner can actually promise.
   */
  const copyExportPath = useCallback(async () => {
    if (!exportNotice) return
    try {
      const { copyText } = await import('../lib/clipboard')
      await copyText(exportNotice.path)
      setExportNotice((prev) =>
        prev ? { ...prev, copied: true, copyError: undefined } : prev
      )
    } catch (err) {
      setExportNotice((prev) =>
        prev
          ? {
              ...prev,
              copied: false,
              copyError: err instanceof Error ? err.message : String(err)
            }
          : prev
      )
    }
  }, [exportNotice])

  const dismissExport = useCallback(() => setExportNotice(null), [])

  return { exportNotice, exportSession, revealExport, copyExportPath, dismissExport }
}
