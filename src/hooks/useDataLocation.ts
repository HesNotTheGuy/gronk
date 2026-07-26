import { useCallback, useEffect, useState } from 'react'
import type { DataLocation, MoveDataResult, StoreHealth } from '../../shared/types'

/**
 * Where the transcript store and the chat sandbox live on disk, plus the
 * one-shot warning for a store that did not load cleanly.
 *
 * `refreshMeta` comes from the composer and is stable for the lifetime of the
 * hook (see the forward handle in useGronk), so it is safe in a dependency
 * array here.
 */
export function useDataLocation(refreshMeta: () => Promise<void>) {
  const [dataLocation, setDataLocation] = useState<DataLocation | null>(null)
  const [dataBusy, setDataBusy] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [dataNotice, setDataNotice] = useState<string | null>(null)
  /** Only set when the store did NOT load cleanly — null means all good. */
  const [storeHealth, setStoreHealth] = useState<StoreHealth | null>(null)

  // Kept out of refreshMeta's Promise.all on purpose: a failure to stat the
  // store must not take sessions, settings and theme down with it.
  const refreshDataLocation = useCallback(async () => {
    try {
      setDataLocation(await window.gronk.getDataLocation())
    } catch (err) {
      setDataError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refreshDataLocation()
  }, [refreshDataLocation])

  /**
   * Read once at startup. A store that failed to parse falls back to defaults, so
   * without this the app would show an empty session list and no explanation —
   * exactly what a wiped install looks like. Dismissible, but never auto-hidden:
   * losing transcripts is worth an interruption.
   */
  useEffect(() => {
    void window.gronk
      .getStoreHealth()
      .then((h) => {
        if (h.degraded) setStoreHealth(h)
      })
      .catch(() => {
        /* a health probe must never be the thing that breaks startup */
      })
  }, [])

  const chooseDataDir = useCallback(async (): Promise<string | null> => {
    setDataError(null)
    try {
      return await window.gronk.chooseDataDir()
    } catch (err) {
      setDataError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  /** Shared move/reset runner — same busy+error shape as runPluginAction. */
  const runDataAction = useCallback(
    async (action: () => Promise<MoveDataResult>) => {
      setDataBusy(true)
      setDataError(null)
      setDataNotice(null)
      try {
        const res = await action()
        setDataLocation(res.location)
        if (res.ok) {
          setDataNotice(res.message)
          // The chat sandbox moved with the store, so cached paths are stale.
          await refreshMeta()
        } else {
          setDataError(res.message)
        }
        return res
      } catch (err) {
        setDataError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setDataBusy(false)
      }
    },
    [refreshMeta]
  )

  const moveDataDir = useCallback(
    (target: string) => runDataAction(() => window.gronk.moveDataDir(target)),
    [runDataAction]
  )

  const resetDataDir = useCallback(
    () => runDataAction(() => window.gronk.resetDataDir()),
    [runDataAction]
  )

  return {
    dataLocation,
    storeHealth,
    // Unchanged from before the split: a fresh arrow every render. Harmless —
    // the object around it is new every render anyway — and nothing downstream
    // memoises on it.
    dismissStoreHealth: () => setStoreHealth(null),
    dataBusy,
    dataError,
    dataNotice,
    chooseDataDir,
    moveDataDir,
    resetDataDir
  }
}
