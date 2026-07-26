import { useCallback, useState } from 'react'

/**
 * The "install the Grok CLI for me" flow and its modal.
 *
 * A successful install changes what `getHealth` and `getGrokPath` report, so it
 * re-reads the app-wide metadata afterwards. `refreshMeta` comes from the
 * composer and is stable for the lifetime of the hook (see the forward handle in
 * useGronk), which is what makes it safe in this dependency array.
 */
export function useCliInstall(refreshMeta: () => Promise<void>) {
  const [showCliInstall, setShowCliInstall] = useState(false)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliInstallResult, setCliInstallResult] = useState<string | null>(null)

  const installCli = useCallback(async () => {
    setCliInstalling(true)
    setCliInstallResult(null)
    try {
      const res = await window.gronk.installCli()
      setCliInstallResult(res.message)
      await refreshMeta()
      return res
    } catch (err) {
      setCliInstallResult(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setCliInstalling(false)
    }
  }, [refreshMeta])

  return {
    showCliInstall,
    setShowCliInstall,
    cliInstalling,
    cliInstallResult,
    setCliInstallResult,
    installCli
  }
}
