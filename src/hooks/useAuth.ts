import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus, LoginMethod, MainToRendererEvent } from '../../shared/types'

interface AuthDeps {
  /**
   * Re-read the app-wide metadata after the account changes. Stable for the
   * lifetime of the hook — see the forward handle in useGronk.
   */
  refreshMeta: () => Promise<void>
  /**
   * Wipe the live conversation. Called from `logout` *before* the CLI is told to
   * sign out, so the previous account's transcript is off screen the moment the
   * user clicks, not one round-trip later. Owned by the composer because the
   * conversation is.
   */
  clearLiveSession: () => void
}

/**
 * Grok account state.
 *
 * Subscribes to `onEvent` itself for the `auth` event — main pushes one whenever
 * the CLI's credentials change under us, and this is the only consumer.
 * `onEvent` supports independent subscribers and returns an unsubscribe
 * function, which the effect returns so a remount cannot leave a second handler
 * behind.
 *
 * `setAuth` is returned for the composer, not for components: several flows
 * outside this hook (opening a project, restoring a session, a health refresh,
 * refreshMeta) already hold a fresh `AuthStatus` and would otherwise have to
 * re-fetch it just to get it into this state.
 */
export function useAuth({ refreshMeta, clearLiveSession }: AuthDeps) {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [deviceHint, setDeviceHint] = useState<string | null>(null)

  useEffect(() => {
    return window.gronk.onEvent((event: MainToRendererEvent) => {
      if (event.type !== 'auth') return
      setAuth(event.auth)
      if (event.auth.authenticated) setAuthMessage(null)
    })
  }, [])

  const refreshAuth = useCallback(async () => {
    setAuthBusy(true)
    try {
      const a = await window.gronk.getAuthStatus()
      setAuth(a)
      setAuthMessage(a.message || null)
    } finally {
      setAuthBusy(false)
    }
  }, [])

  const login = useCallback(
    async (method: LoginMethod = 'oauth') => {
      setAuthBusy(true)
      setAuthMessage(
        method === 'device'
          ? 'Device login started. Complete the code in your browser…'
          : 'Browser login started. Complete sign-in in the window that opens…'
      )
      setDeviceHint(null)
      try {
        const result = await window.gronk.login(method)
        setAuth(result.auth)
        setAuthMessage(result.message)
        if (result.deviceHint) setDeviceHint(result.deviceHint)
        if (result.ok) {
          await refreshMeta()
        }
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setAuthMessage(msg)
        return null
      } finally {
        setAuthBusy(false)
      }
    },
    [refreshMeta]
  )

  const logout = useCallback(async () => {
    setAuthBusy(true)
    setDeviceHint(null)
    try {
      // Clear live session UI immediately
      clearLiveSession()

      const result = await window.gronk.logout()
      setAuth(result.auth)
      setAuthMessage(result.message)
      await refreshMeta()
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAuthMessage(msg)
      return null
    } finally {
      setAuthBusy(false)
    }
  }, [refreshMeta, clearLiveSession])

  const isAuthenticated = !!auth?.authenticated

  return {
    auth,
    authBusy,
    authMessage,
    deviceHint,
    isAuthenticated,
    refreshAuth,
    login,
    logout,
    setAuth
  }
}
