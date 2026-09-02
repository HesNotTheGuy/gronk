/**
 * Renders every app state and compares it against a committed baseline image.
 *
 * This exists because the test suite cannot see the screen. The activity heatmap
 * shipped in v0.1.0 with no CSS at all and every test passed, because the tests
 * asserted its data and the data was correct. Nothing rendered anything. Four
 * more bugs followed the same pattern.
 *
 * Electron with show:false, so no window appears, but it is a real Chromium at a
 * fixed size, so the images match what the packaged app draws.
 *
 * Two modes:
 *   normal             capture, compare to tests/visual/baseline, report drift
 *   UPDATE_BASELINE=1  capture and overwrite the baseline instead
 *
 * Comparison uses Electron's own nativeImage to decode PNGs, so no new npm
 * dependency is needed to handle images.
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const BASE = 'http://localhost:5178/__shots.html'
const ROOT = path.resolve(__dirname, '..', '..')
const BASELINE = path.join(ROOT, 'tests/visual/baseline')
const CURRENT = path.join(ROOT, 'tests/visual/current')
const DIFF = path.join(ROOT, 'tests/visual/diff')
const UPDATE = process.env.UPDATE_BASELINE === '1'

const WIDTH = 1440
const HEIGHT = 900

/**
 * A pixel counts as changed when any colour channel moves by more than this.
 * Font antialiasing jitters by a few units between runs on one machine; a real
 * styling change moves far more.
 */
const CHANNEL_TOLERANCE = 8
/** Fraction of pixels allowed to differ before a scenario is called changed. */
const MAX_CHANGED_FRACTION = 0.001

/**
 * Rasterisation has to be deterministic, or the comparison is worthless.
 *
 * The first baseline was captured at the display's own scale factor with GPU
 * rasterisation and subpixel text. Re-running it hours later on the SAME machine
 * reported every one of the 30 scenarios as changed, 2 to 8 percent each, with
 * layout pixel-identical and only glyphs and antialiased edges moving. That is
 * not a regression, it is the harness measuring the compositor's mood.
 *
 * Forcing 1x, disabling subpixel text, and rendering in software removes the
 * three inputs that drifted. Software rendering is slower and that is fine: this
 * runs once before a release.
 */
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-lcd-text')
app.commandLine.appendSwitch('disable-font-subpixel-positioning')
app.disableHardwareAcceleration()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []

const SESSION_TITLE = 'Rate limiter drops bursts under load'

/**
 * Home is a landing pad and no longer lists sessions. The fixture title lives
 * on Build. A scenario that starts with clickText: SESSION_TITLE from default
 * Home photographs Home and reports a missing step.
 */
const OPEN_SESSION = [
  { clickText: 'Build' },
  { wait: 1400 },
  { clickText: SESSION_TITLE },
  { wait: 1800 }
]

const PERMISSION_EVENT = {
  type: 'permission-request',
  request: {
    requestId: 42,
    sessionId: 's-orbital-1',
    toolCallId: 't9',
    title: 'src/limit/rate-limiter.ts',
    kind: 'edit',
    rawInput: {
      path: 'src/limit/rate-limiter.ts',
      diff: `@@ -14,9 +14,13 @@ export class RateLimiter {
-  private tokens = this.capacity
+  private tokens: number
+  private lastRefill = Date.now()

-  allow(): boolean {
-    if (this.tokens <= 0) return false
+  allow(cost = 1): boolean {
+    this.refill()
+    if (this.tokens < cost) return false
     return true
   }`
    }
  }
}

const USAGE_EVENT = {
  type: 'usage',
  sessionId: 's-orbital-1',
  usage: {
    sessionId: 's-orbital-1',
    turns: 1,
    totals: {
      inputTokens: 13600,
      outputTokens: 1000,
      totalTokens: 14600,
      cachedReadTokens: 1000,
      reasoningTokens: 420,
      modelCalls: 3,
      apiDurationMs: 18400,
      costUsd: 0.28
    },
    last: {
      inputTokens: 13600,
      outputTokens: 1000,
      totalTokens: 14600,
      cachedReadTokens: 1000,
      reasoningTokens: 420,
      modelCalls: 3,
      apiDurationMs: 18400,
      costUsd: 0.28
    }
  }
}

const usageSteps = [
  ...OPEN_SESSION,
  { emit: USAGE_EVENT },
  { wait: 800 },
  // The tray's own Usage tab. It was `.usage-summary`, a control on UsageMeter,
  // which nothing renders any more — so this step could not succeed and both usage
  // scenarios were captured with the panel still closed, quietly shooting the wrong
  // screen while reporting "errored" in a line that is easy to scroll past.
  { clickText: 'Usage' },
  { wait: 700 }
]

/**
 * Each scenario: the ?state= to load, then the steps to reach the view.
 * Step kinds: click (CSS selector), clickText (button containing text),
 * type (set an input's value), emit (push a main-process event), wait (ms).
 */
const SCENARIOS = [
  { name: 'preview-docked', state: 'preview', steps: [...OPEN_SESSION] },
  { name: 'preview-popped', state: 'preview-popped', steps: [...OPEN_SESSION] },
  { name: 'remote-images', state: 'remoteimg', steps: [...OPEN_SESSION] },
  {
    name: 'row-menu',
    state: 'default',
    steps: [...OPEN_SESSION, { click: '.session-item-row .menu-btn.icon' }, { wait: 700 }]
  },
  { name: 'sidebar-footer', state: 'default', steps: [{ clickText: 'Build' }, { wait: 1200 }] },
  {
    name: 'skills-tab',
    state: 'default',
    steps: [
      { clickText: 'Settings' },
      { wait: 900 },
      { clickText: 'Manage plugins' },
      { wait: 1600 },
      { clickText: 'Skills' },
      { wait: 900 }
    ]
  },
  {
    name: 'marketplace-origin',
    state: 'default',
    steps: [{ clickText: 'Settings' }, { wait: 900 }, { clickText: 'Manage plugins' }, { wait: 1600 }]
  },
  {
    name: 'search',
    state: 'default',
    steps: [
      { clickText: 'Build' },
      { wait: 1200 },
      { type: { selector: '.sidebar-search-input', text: 'backoff' } },
      { wait: 900 }
    ]
  },
  { name: 'nav-build-browse', state: 'default', steps: [{ clickText: 'Build' }, { wait: 1400 }] },
  { name: 'nav-chat-browse', state: 'default', steps: [{ clickText: 'Chat' }, { wait: 1400 }] },
  { name: 'light-home', state: 'light-home', steps: [] },
  {
    name: 'light-build',
    state: 'light-build',
    steps: [...OPEN_SESSION, { click: '.tool-activity-bar' }, { wait: 800 }]
  },
  { name: 'light-settings', state: 'light-settings', steps: [{ clickText: 'Settings' }, { wait: 1200 }] },
  { name: 'usage-session', state: 'default', steps: usageSteps },
  { name: 'usage-apikey', state: 'apikey', steps: usageSteps },
  // Published as docs/images/home.png and docs/images/build.png. After a recapture
  // that actually changes one of these, copy the PNG — do not paste a live Gronk
  // window. Home is a landing pad; Build still shows the filler folders.
  { name: 'readme-home', state: 'default', steps: [] },
  {
    name: 'readme-build',
    state: 'default',
    steps: [...OPEN_SESSION, { click: '.tool-activity-bar' }, { wait: 900 }]
  },
  { name: 'readme-chat', state: 'default', steps: [{ clickText: 'Chat' }, { wait: 1400 }] },
  { name: 'readme-settings', state: 'default', steps: [{ clickText: 'Settings' }, { wait: 1200 }] },
  { name: 'signin', state: 'signin', steps: [] },
  { name: 'nocli', state: 'nocli', steps: [] },
  { name: 'empty', state: 'empty', steps: [] },
  { name: 'degraded', state: 'degraded', steps: [] },
  { name: 'yolo-chat', state: 'yolo', steps: [{ clickText: 'Chat' }, { wait: 1200 }] },
  {
    name: 'permission',
    state: 'default',
    steps: [...OPEN_SESSION, { emit: PERMISSION_EVENT }, { wait: 1200 }]
  },
  {
    name: 'toolfail',
    state: 'toolfail',
    steps: [...OPEN_SESSION, { click: '.tool-activity-bar' }, { wait: 900 }]
  },
  { name: 'streaming', state: 'streaming', steps: [...OPEN_SESSION] },
  { name: 'preview', state: 'preview', steps: [...OPEN_SESSION] },
  {
    name: 'plugins',
    state: 'default',
    steps: [{ clickText: 'Settings' }, { wait: 900 }, { clickText: 'Manage plugins' }, { wait: 1800 }]
  },
  {
    name: 'cloudsync',
    state: 'default',
    steps: [{ clickText: 'Settings' }, { wait: 900 }, { clickText: 'Move…' }, { wait: 1000 }]
  },
  // The two project menus. __shots.tsx opens these itself, because a menu is not
  // a route: it exists only after a click and closes on the next one, so a bare
  // ?state= would photograph the view underneath. Only a wait is needed here.
  {
    // Pinned at half-screen width, which is where the overflow was reported and
    // the only width at which it reproduces. The image is oversized on purpose
    // so the max-width cap actually binds.
    name: 'lightbox-narrow',
    state: 'lightbox',
    width: 1000,
    height: 820,
    steps: [...OPEN_SESSION, { click: '.local-image-btn' }, { wait: 900 }]
  },
  /*
   * The catalogue. Twenty-four `![name](path)` in one reply, six of them not on
   * disk, which used to be twenty-four full width cards and six bordered error
   * boxes: some thirteen thousand pixels of one answer.
   *
   * Three shots because three separate things can regress independently. The
   * grid itself; the failure list, which is behind a click and would otherwise
   * never be looked at; and the light theme, where the matte behind each
   * thumbnail is a different colour and a white SVG has to stay distinguishable
   * from the page it sits on.
   */
  {
    name: 'image-catalogue',
    state: 'catalogue',
    steps: [...OPEN_SESSION, { wait: 400 }]
  },
  {
    name: 'image-catalogue-failures',
    state: 'catalogue',
    steps: [...OPEN_SESSION, { wait: 400 }, { click: '.md-image-failures-toggle' }, { wait: 700 }]
  },
  {
    name: 'light-image-catalogue',
    state: 'light-catalogue',
    steps: [...OPEN_SESSION, { wait: 400 }]
  },
  {
    // Narrow enough that auto-fill actually has to give up columns: the bubble
    // is capped at 700px, so anything wider than about 1050 photographs the
    // same six. A grid that only works at a comfortable window is the lightbox
    // bug over again.
    name: 'image-catalogue-narrow',
    state: 'catalogue',
    width: 760,
    height: 820,
    steps: [...OPEN_SESSION, { wait: 400 }]
  },
  { name: 'project-menu', state: 'project-menu', steps: [{ wait: 2500 }] },
  { name: 'folder-menu', state: 'folder-menu', steps: [{ wait: 2500 }] },
  {
    // The reason the active-state work happened at all: a project you already
    // have open used to render with a selection-style border on a screen you
    // reached without selecting anything. Getting there needs a project opened
    // and then a walk back to the browse list, since nothing sets an active cwd
    // on arrival. Without this scenario the fix has no picture and could regress
    // to exactly the ambiguity it was built to remove.
    name: 'browse-with-active-project',
    state: 'default',
    steps: [...OPEN_SESSION, { clickText: 'Build' }, { wait: 1600 }]
  }
]

async function runStep(win, step) {
  if (step.wait) return wait(step.wait)

  if (step.emit) {
    return win.webContents.executeJavaScript(
      `(() => { window.__emit(${JSON.stringify(step.emit)}); return true })()`
    )
  }

  if (step.type) {
    return win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(step.type.selector)})
      if (!el) return { ok: false, selector: ${JSON.stringify(step.type.selector)} }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set
      setter.call(el, ${JSON.stringify(step.type.text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    })()`)
  }

  if (step.click) {
    return win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(step.click)})
      if (!el) return { ok: false, selector: ${JSON.stringify(step.click)} }
      el.click()
      return { ok: true }
    })()`)
  }

  if (step.clickText) {
    return win.webContents.executeJavaScript(`(() => {
      const wanted = ${JSON.stringify(step.clickText.toLowerCase())}
      const els = Array.from(document.querySelectorAll('button, [role=button], a'))
      const el = els.find((e) => (e.textContent || '').trim().toLowerCase().includes(wanted))
      if (!el) return {
        ok: false,
        wanted,
        seen: els.map((e) => (e.textContent || '').trim().slice(0, 28)).filter(Boolean).slice(0, 25)
      }
      el.click()
      return { ok: true }
    })()`)
  }
  return null
}

/**
 * Compare two PNGs pixel by pixel.
 *
 * nativeImage hands back BGRA. Alpha is ignored: both images are opaque
 * screenshots, so comparing it only adds noise.
 */
function comparePng(baselineBuffer, currentBuffer) {
  const a = nativeImage.createFromBuffer(baselineBuffer)
  const b = nativeImage.createFromBuffer(currentBuffer)
  const sizeA = a.getSize()
  const sizeB = b.getSize()

  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
    return {
      changed: true,
      reason: `size changed: ${sizeA.width}x${sizeA.height} to ${sizeB.width}x${sizeB.height}`,
      changedPixels: -1,
      fraction: 1,
      diffImage: null
    }
  }

  const bufA = a.toBitmap()
  const bufB = b.toBitmap()
  const total = sizeA.width * sizeA.height
  const diff = Buffer.alloc(bufA.length)
  let changedPixels = 0

  for (let i = 0; i < bufA.length; i += 4) {
    const moved =
      Math.abs(bufA[i] - bufB[i]) > CHANNEL_TOLERANCE ||
      Math.abs(bufA[i + 1] - bufB[i + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(bufA[i + 2] - bufB[i + 2]) > CHANNEL_TOLERANCE

    if (moved) {
      changedPixels++
      // Magenta marks what moved; unchanged pixels keep a dimmed copy of the
      // new render so the diff reads as a picture instead of confetti on black.
      diff[i] = 255
      diff[i + 1] = 0
      diff[i + 2] = 255
      diff[i + 3] = 255
    } else {
      diff[i] = Math.round(bufB[i] * 0.25)
      diff[i + 1] = Math.round(bufB[i + 1] * 0.25)
      diff[i + 2] = Math.round(bufB[i + 2] * 0.25)
      diff[i + 3] = 255
    }
  }

  const fraction = changedPixels / total
  return {
    changed: fraction > MAX_CHANGED_FRACTION,
    changedPixels,
    fraction,
    reason: null,
    diffImage: changedPixels > 0 ? nativeImage.createFromBuffer(diff, sizeA).toPNG() : null
  }
}

app.whenReady().then(async () => {
  for (const dir of [BASELINE, CURRENT, DIFF]) fs.mkdirSync(dir, { recursive: true })
  for (const dir of [CURRENT, DIFF]) {
    for (const stale of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, stale))
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    backgroundColor: '#000000',
    // offscreen: a hidden normal window does not composite, so capturePage()
    // hands back a stale frame. A permission modal that had genuinely rendered
    // (measured opacity 1) was simply missing from the PNG. Offscreen rendering
    // paints into a buffer on every change, with no window ever shown.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })

  for (const scenario of SCENARIOS) {
    const entry = { name: scenario.name, steps: [] }
    // A scenario may pin its own window size. The lightbox overflow only
    // appeared below roughly 1490px wide, because a 1200px cap happened to be
    // smaller than the pane above that. Capturing everything at one comfortable
    // width is how a layout bug hides from a layout test.
    const w = scenario.width || WIDTH
    const h = scenario.height || HEIGHT
    try {
      win.setBounds({ x: 0, y: 0, width: w, height: h })
      await wait(200)
      await win.loadURL(`${BASE}?state=${scenario.state}`)
      // A hidden window does not composite, so CSS animations never advance and
      // anything using `animation: ... both` freezes on its first keyframe. The
      // modal backdrop starts at opacity 0, which made a correctly rendered
      // permission dialog look absent. Captures should show settled states anyway.
      await wait(2200)
      // webContents.insertCSS did NOT take effect here (computed animationName
      // stayed 'rise'); injecting a style element from inside the page does.
      await win.webContents.executeJavaScript(`(() => {
        const s = document.createElement('style')
        s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
        document.head.appendChild(s)
        return true
      })()`)
      await wait(300)

      for (const step of scenario.steps) {
        const result = await runStep(win, step)
        if (result && result.ok === false) {
          entry.steps.push({ step: step.click || step.clickText, ...result })
        }
      }
      await wait(500)

      // Resize to logical pixels so a HiDPI machine and a 1x machine produce
      // comparable images, and so the committed baseline stays a sane size.
      const image = (await win.webContents.capturePage()).resize({ width: w, height: h })
      const png = image.toPNG()
      entry.bytes = png.length

      const baselinePath = path.join(BASELINE, `${scenario.name}.png`)

      if (UPDATE) {
        fs.writeFileSync(baselinePath, png)
        entry.status = 'baseline-written'
      } else if (!fs.existsSync(baselinePath)) {
        fs.writeFileSync(path.join(CURRENT, `${scenario.name}.png`), png)
        entry.status = 'no-baseline'
      } else {
        const result = comparePng(fs.readFileSync(baselinePath), png)
        entry.changedPixels = result.changedPixels
        entry.fraction = Number(result.fraction.toFixed(6))
        if (result.reason) entry.reason = result.reason
        entry.status = result.changed ? 'changed' : 'unchanged'
        if (result.changed) {
          fs.writeFileSync(path.join(CURRENT, `${scenario.name}.png`), png)
          if (result.diffImage) {
            fs.writeFileSync(path.join(DIFF, `${scenario.name}.png`), result.diffImage)
          }
        }
      }
    } catch (err) {
      entry.status = 'error'
      entry.error = String((err && err.message) || err)
    }
    report.push(entry)
  }

  console.log('===RESULTS===')
  console.log(JSON.stringify(report, null, 2))
  app.exit(0)
})
