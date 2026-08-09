/**
 * Environment IPC: the Grok CLI binary, its version and installer, auth
 * (status / login / logout), overall health and the model list.
 */

import { clipboard, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { resolveGrokBinary } from '../acp/client'
import { agentManager } from '../agent-manager'
import { getAuthStatus, loginWithCli, logoutWithCli } from '../auth'
import { getCliVersion } from '../cli-version'
import { assertTrustedSender } from '../ipc-guard'
import { listModels } from '../models'
import { redactSecrets } from '../redact'
import { getSettings } from '../store'
import type { IpcContext } from './context'
import type { LoginMethod } from '../../../shared/types'

/**
 * Install the Grok CLI via the official x.ai installer. Only ever called from the
 * user-consented install modal — never automatically. Runs the platform installer,
 * then re-detects the binary.
 */
function installGrokCli(): Promise<{
  ok: boolean
  message: string
  grokPath: string | null
  installed: boolean
}> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'powershell.exe' : 'bash'
    const args = isWin
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://x.ai/cli/install.ps1 | iex'
        ]
      : // curl is not guaranteed on a minimal Linux image — Alpine's busybox ships
        // wget but no curl, and Debian slim ships neither. Without a fallback the
        // only symptom is "command not found" buried in the installer output tail.
        [
          '-lc',
          'if command -v curl >/dev/null 2>&1; then curl -fsSL https://x.ai/cli/install.sh | bash; ' +
            'elif command -v wget >/dev/null 2>&1; then wget -qO- https://x.ai/cli/install.sh | bash; ' +
            'else echo "Neither curl nor wget is installed. Install one, or run the Grok CLI installer manually: https://x.ai/cli" >&2; exit 127; fi'
        ]

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(cmd, args, { windowsHide: true, env: process.env })
    } catch (err) {
      resolve({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        grokPath: null,
        installed: false
      })
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 240_000)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      out += c
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      out += c
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, message: err.message, grokPath: null, installed: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const grokPath = resolveGrokBinary(getSettings().grokBinary)
      const installed = !!grokPath
      const tail = redactSecrets((out || '').slice(-1500)).trim()
      resolve({
        ok: installed,
        message: installed
          ? 'Grok CLI installed. Sign in with your own account to continue.'
          : tail ||
            `Installer exited (code ${code ?? '?'}) but the grok binary was not found. Restart Gronk or install manually.`,
        grokPath,
        installed
      })
    })
  })
}

export function registerSystemIpc(ctx: IpcContext): void {
  ipcMain.handle('gronk:list-models', (e) => {
    assertTrustedSender(e)
    return listModels()
  })

  ipcMain.handle('gronk:get-grok-path', (e) => {
    assertTrustedSender(e)
    const settings = getSettings()
    return resolveGrokBinary(settings.grokBinary)
  })

  ipcMain.handle('gronk:get-health', async (e) => {
    assertTrustedSender(e)
    const settings = getSettings()
    const grokPath = resolveGrokBinary(settings.grokBinary)
    const auth = await getAuthStatus()
    return {
      grokFound: !!grokPath,
      grokPath,
      nodeOk: true,
      platform: process.platform,
      auth
    }
  })

  ipcMain.handle('gronk:get-cli-version', async (e) => {
    assertTrustedSender(e)
    return getCliVersion()
  })

  ipcMain.handle('gronk:get-auth-status', async (e) => {
    assertTrustedSender(e)
    return getAuthStatus()
  })

  ipcMain.handle('gronk:login', async (e, method?: LoginMethod) => {
    assertTrustedSender(e)
    const m = method === 'device' ? 'device' : 'oauth'
    const result = await loginWithCli(m)
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('gronk:event', {
        type: 'auth',
        auth: result.auth
      })
    }
    return result
  })

  ipcMain.handle('gronk:logout', async (e) => {
    assertTrustedSender(e)
    try {
      await agentManager.stopAll()
    } catch {
      /* best effort */
    }
    const result = await logoutWithCli()
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('gronk:event', {
        type: 'auth',
        auth: result.auth
      })
    }
    return result
  })

  ipcMain.handle('gronk:install-cli', async (e) => {
    assertTrustedSender(e)
    return installGrokCli()
  })

  /**
   * Write text to the OS clipboard from main. The renderer Clipboard API is
   * gated by Chromium permission checks that we otherwise deny wholesale; this
   * path is the reliable one for explicit Copy buttons after assertTrustedSender.
   */
  ipcMain.handle('gronk:write-clipboard', (e, text: unknown) => {
    assertTrustedSender(e)
    if (typeof text !== 'string') throw new Error('text must be a string')
    // Cap so a runaway payload cannot pin megabytes into the system clipboard.
    if (text.length > 2_000_000) throw new Error('text too large to copy')
    clipboard.writeText(text)
  })

  /**
   * Match the Windows title-bar overlay to the resolved app theme. Light mode
   * used to keep the dark overlay from createWindow forever.
   */
  ipcMain.handle('gronk:set-chrome-theme', (e, theme: unknown) => {
    assertTrustedSender(e)
    if (theme !== 'dark' && theme !== 'light') throw new Error('Invalid chrome theme')
    if (process.platform !== 'win32') return
    const win = ctx.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (theme === 'light') {
      win.setTitleBarOverlay({ color: '#f0efeb', symbolColor: '#141414', height: 40 })
    } else {
      win.setTitleBarOverlay({ color: '#0a0a0a', symbolColor: '#e5e5e5', height: 40 })
    }
  })
}
