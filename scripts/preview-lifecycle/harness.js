/**
 * Exercises the preview's pop-out lifecycle against REAL Electron.
 *
 * Everything else that touches preview.ts either stubs Electron (node --test
 * cannot construct a BrowserWindow) or fakes the IPC (the screenshot harness),
 * so popOutPreview/dockPreview/stopPreview shipped without their window
 * lifecycle ever having run. That is how the teardown bug got in: stopPreview()
 * destroys the detached window while currentUrl is still set, 'closed' fires
 * SYNCHRONOUSLY, and the handler re-attached a pane for the preview being torn
 * down — emitting a preview-status still carrying the dev URL, so the UI
 * flashed "running" right after the user hit stop. Reading the code did not
 * settle whether 'closed' was synchronous. Running it did.
 *
 * The security assertions matter as much as the lifecycle ones: a detached
 * window that quietly lost the sandbox, the partition, or the localhost lock
 * would just be an unrestricted browser sitting next to the agent.
 *
 * A plain local HTTP server stands in for the dev server, so this never runs an
 * npm script and never touches the Grok CLI.
 *
 * Run with `npm run test:preview`. Requires a display; not wired into CI.
 */
const { app, BrowserWindow, session } = require('electron')
const http = require('node:http')

const preview = require('./preview.cjs')

const results = []
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Windows the harness itself did not create. */
const previewWindows = (host) =>
  BrowserWindow.getAllWindows().filter((w) => w !== host && !w.isDestroyed())

/** Keep test windows off the user's screen; popOutPreview does not take a position. */
const hide = (windows) => windows.forEach((w) => w.setPosition(-4000, -4000))

app.whenReady().then(async () => {
  const events = []
  let server

  try {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>stand-in dev server</h1></body></html>')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/`

    const host = new BrowserWindow({ show: false, width: 1200, height: 800 })
    preview.initPreview(host, (type, payload) => events.push({ type, payload }))
    preview.setPreviewBounds({ x: 300, y: 60, width: 800, height: 700 })

    // ---- docked ---------------------------------------------------------
    preview.setPreviewUrl(url)
    await wait(600)
    check('docked view attached', host.contentView.children.length === 1,
      `children=${host.contentView.children.length}`)
    check('status reports not popped out', preview.getPreviewStatus().poppedOut === false)

    // ---- pop out --------------------------------------------------------
    const popResult = preview.popOutPreview()
    const popped = previewWindows(host)
    hide(popped)
    await wait(900)

    check('popOutPreview returned ok', popResult.ok === true, JSON.stringify(popResult))
    check('exactly one detached window', popped.length === 1, `windows=${popped.length}`)
    check('isPreviewPoppedOut() true', preview.isPreviewPoppedOut() === true)
    // Two live views on one URL would both hold the dev server's socket and run
    // its JavaScript, so a page with a timer or websocket does everything twice.
    check('docked view was destroyed', host.contentView.children.length === 0,
      `children=${host.contentView.children.length}`)

    if (popped[0]) {
      const wc = popped[0].webContents
      const prefs = wc.getLastWebPreferences() || {}
      check('detached window: sandboxed', prefs.sandbox === true, `sandbox=${prefs.sandbox}`)
      check('detached window: context isolated', prefs.contextIsolation !== false,
        `contextIsolation=${prefs.contextIsolation}`)
      check('detached window: no nodeIntegration', !prefs.nodeIntegration,
        `nodeIntegration=${prefs.nodeIntegration}`)
      check('detached window: NO preload', !prefs.preload, `preload=${prefs.preload || 'none'}`)

      // getLastWebPreferences() does not echo `partition`, so comparing it there
      // reports undefined and proves nothing. Session identity is the real check.
      check('detached window: preview partition, not the app default session',
        wc.session === session.fromPartition('preview') && wc.session !== session.defaultSession,
        `isDefault=${wc.session === session.defaultSession}`)
      // 'preview' carries no `persist:` prefix, so the session is in-memory and
      // getStoragePath() is empty BY DESIGN: a preview leaves nothing on disk.
      check('detached window: ephemeral session, nothing persisted',
        !wc.session.getStoragePath(), `storage=${wc.session.getStoragePath() || '(none)'}`)

      check('detached window loaded the dev URL', wc.getURL().startsWith('http://127.0.0.1:'),
        wc.getURL())

      // No preload means no bridge: nothing here can reach the agent, the
      // transcript store or the filesystem.
      const reach = await wc.executeJavaScript(
        `({ gronk: typeof window.gronk, req: typeof window.require, proc: typeof window.process })`
      )
      check('detached page has no window.gronk', reach.gronk === 'undefined', JSON.stringify(reach))
      check('detached page has no require', reach.req === 'undefined', JSON.stringify(reach))

      // Off-localhost navigation is refused. Opt-in: passing means the URL is
      // handed to openExternalSafely(), which pops a real tab in the user's
      // browser every single run.
      if (process.env.CHECK_NAV_GUARD === '1') {
        const before = wc.getURL()
        await wc.executeJavaScript(`window.location.href = 'https://example.com/'`).catch(() => {})
        await wait(1200)
        check('detached window refuses off-localhost navigation', wc.getURL() === before,
          `now=${wc.getURL()}`)
      }
    }

    // ---- dock it back ---------------------------------------------------
    preview.dockPreview()
    await wait(900)
    check('dockPreview closed the window', previewWindows(host).length === 0,
      `windows=${previewWindows(host).length}`)
    check('isPreviewPoppedOut() false again', preview.isPreviewPoppedOut() === false)
    // Closing means "put it back", not "stop the server".
    check('pane re-attached on close', host.contentView.children.length === 1,
      `children=${host.contentView.children.length}`)

    // ---- teardown while detached (the regression) -----------------------
    preview.popOutPreview()
    hide(previewWindows(host))
    await wait(800)
    check('popped out again for teardown test', preview.isPreviewPoppedOut() === true)

    events.length = 0
    preview.stopPreview()
    await wait(1500)

    check('stopPreview: no windows left', previewWindows(host).length === 0,
      `windows=${previewWindows(host).length}`)
    check('stopPreview: no pane left', host.contentView.children.length === 0,
      `children=${host.contentView.children.length}`)
    check('stopPreview: status is not running', preview.getPreviewStatus().running === false)
    check('stopPreview: url cleared', preview.getPreviewStatus().url === null,
      `url=${preview.getPreviewStatus().url}`)
    // The regression itself: teardown must not emit a status still carrying the
    // dev URL, which is what told the UI the preview was alive after stop.
    const resurrected = events.filter((e) => e.type === 'preview-status' && e.payload?.url)
    check('stopPreview: emitted no status carrying a URL', resurrected.length === 0,
      JSON.stringify(resurrected.map((e) => e.payload.url)))

    host.destroy()
  } catch (err) {
    check('harness completed', false, String((err && err.stack) || err))
  }

  if (server) server.close()
  console.log('===RESULTS===')
  console.log(JSON.stringify(results, null, 2))
  app.exit(results.some((r) => !r.pass) ? 1 : 0)
})
