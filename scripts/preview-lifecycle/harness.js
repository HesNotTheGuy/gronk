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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const preview = require('./preview.cjs')

const results = []
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until the value is truthy or the budget runs out. Returns it, or null. */
async function until(fn, budgetMs) {
  const step = 250
  for (let waited = 0; waited < budgetMs; waited += step) {
    const value = await fn()
    if (value) return value
    await wait(step)
  }
  return null
}

/** GET a URL, resolving to null when nothing is listening. */
function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

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
      // STRICT equality on purpose. `!prefs.nodeIntegration` and
      // `prefs.contextIsolation !== false` both pass when the key is merely
      // ABSENT, which is how the partition check silently asserted nothing:
      // getLastWebPreferences() does not echo every key it is given. A check
      // that cannot distinguish "correct" from "not reported" is decoration.
      check('detached window: sandboxed', prefs.sandbox === true, `sandbox=${prefs.sandbox}`)
      check('detached window: context isolated', prefs.contextIsolation === true,
        `contextIsolation=${prefs.contextIsolation}`)
      check('detached window: no nodeIntegration', prefs.nodeIntegration === false,
        `nodeIntegration=${prefs.nodeIntegration}`)
      // preload is NOT echoed back when absent, so a readback here would be
      // exactly the vacuous check described above. Proven from inside the page
      // instead, below: no preload ran means no window.gronk exists.

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
      // transcript store or the filesystem. Asserted from INSIDE the page,
      // which cannot pass vacuously the way a webPreferences readback can.
      const reach = await wc.executeJavaScript(`({
        gronk: typeof window.gronk,
        req: typeof window.require,
        proc: typeof window.process,
        mod: typeof window.module,
        buf: typeof window.Buffer
      })`)
      check('detached page has no window.gronk (proves no preload ran)',
        reach.gronk === 'undefined', JSON.stringify(reach))
      check('detached page has no require', reach.req === 'undefined', JSON.stringify(reach))
      check('detached page has no process', reach.proc === 'undefined', JSON.stringify(reach))
      check('detached page has no module', reach.mod === 'undefined', JSON.stringify(reach))
      check('detached page has no Buffer', reach.buf === 'undefined', JSON.stringify(reach))

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

    // ---- startPreview: spawn, stdout scan, kill ------------------------
    // Previously untested end to end. setPreviewUrl() above reaches attachView
    // directly, so the whole dev-process half of preview.ts - resolveCommand,
    // spawn, the stdout URL scan, and the platform kill path - never ran.
    // A tiny node server stands in for a dev server: no npm script, no CLI.
    const projectDir = path.join(os.tmpdir(), 'gronk-preview-lifecycle-project')
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'dev-server.js'),
      [
        "const http = require('http')",
        "const s = http.createServer((_q, r) => {",
        "  r.writeHead(200, { 'Content-Type': 'text/html' })",
        "  r.end('<h1>spawned dev server</h1>')",
        '})',
        // Printed the way a real dev server announces itself, so the stdout
        // scanner is tested against a realistic line rather than a bare URL.
        "s.listen(0, '127.0.0.1', () => {",
        "  console.log('  \\u279c  Local:   http://localhost:' + s.address().port + '/')",
        '})'
      ].join('\n')
    )

    // No package.json, so resolveCommand finds nothing and must say so.
    const noCommand = preview.startPreview(projectDir)
    check('startPreview with no dev script explains why',
      noCommand.ok === false && /no dev command/i.test(noCommand.message), noCommand.message)
    check('startPreview with no dev script did not mark itself running',
      preview.getPreviewStatus().running === false)

    // Explicit override: exercises spawn + the stdout URL scan + attachView.
    const started = preview.startPreview(projectDir, 'node dev-server.js')
    check('startPreview reported success', started.ok === true, JSON.stringify(started))

    const found = await until(() => preview.getPreviewStatus().url, 20000)
    check('found the dev URL in the spawned process stdout', !!found, `url=${found}`)

    if (found) {
      check('discovered URL is a localhost dev URL', /^http:\/\/localhost:\d+\/?$/.test(found), found)
      check('pane attached for the spawned server', host.contentView.children.length === 1,
        `children=${host.contentView.children.length}`)
      check('status reports running', preview.getPreviewStatus().running === true)

      const port = new URL(found).port
      const body = await httpGet(`http://127.0.0.1:${port}/`)
      check('the spawned dev server actually served a page',
        /spawned dev server/.test(body || ''), String(body).slice(0, 60))

      // The kill path is the part that has bitten this project before: npm hands
      // the server to a grandchild and the tree walk misses it.
      preview.stopPreview()
      const released = await until(async () => (await httpGet(`http://127.0.0.1:${port}/`)) === null, 15000)
      check('stopPreview released the port', !!released,
        released ? '' : 'something is still listening on the port')
      check('stopPreview cleared running state', preview.getPreviewStatus().running === false)
      check('stopPreview removed the pane', host.contentView.children.length === 0,
        `children=${host.contentView.children.length}`)
    }

    fs.rmSync(projectDir, { recursive: true, force: true })

    host.destroy()
  } catch (err) {
    check('harness completed', false, String((err && err.stack) || err))
  }

  if (server) server.close()
  console.log('===RESULTS===')
  console.log(JSON.stringify(results, null, 2))
  app.exit(results.some((r) => !r.pass) ? 1 : 0)
})
