---
name: verify-gronk
description: Drive the Gronk Electron renderer the way a user does — launch an isolated npm run dev instance, doctor it, click Home/Chat/Build/Focus/permission surfaces over CDP, and capture evidence. Use when proving UI behavior, after renderer or shell changes, or when npm test cannot see the screen.
---

# Verify Gronk

Gronk is an Electron desktop app. The user-facing surface is the renderer. This skill launches a **disposable** `npm run dev` instance, drives it over CDP, and captures proof. It does not replace `npm test`, `npm run typecheck`, `npm run test:visual`, or `npm run test:preview`.

Write for the next agent that has never seen the app. Commands below are literal.

`node .cursor/skills/verify-gronk/control-gronk.mjs --help` lists commands.

## Interview (what this repo actually is)

- **Surface:** Electron renderer (React). Secondary: Grok CLI over ACP (not driven here). Visual shots harness (`src/__shots.tsx`, port 5178) is a fake-bridge gallery, not the app.
- **Run:** `npm run dev` (`electron-vite dev`). Node `>=22.18`. No Gronk tokens — credentials stay in the Grok CLI.
- **Drive:** This skill's CDP driver against a real window. Existing harnesses stay: `npm run test:visual` (38 states, screenshot baselines; issue #111 false-positives; do not re-record blindly), `npm run test:preview` (dev-server preview under real Electron), `npm test` / `npm run typecheck`.
- **Observe:** CDP screenshot, ARIA/DOM snapshot, doctor JSON, launch log. Session files only in the disposable userData.
- **Isolate:** Always `--user-data-dir` under `$TMPDIR/gronk-verify/`. Never `~/.config/gronk` (Linux), `~/Library/Application Support/gronk` (macOS), or `%APPDATA%\gronk` (Windows). The app takes a single-instance lock per userData; two runs that share a dir fight. Refuse to drive an instance this run did not start unless `--cdp` is passed on purpose.

## Launch

From the repo root, Node 22.18+:

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs launch
```

That is `npm run dev` plus electron-vite's own flags (not a second stack):

```bash
npx electron-vite --remoteDebuggingPort 9333 --noSandbox -- --user-data-dir "$TMPDIR/gronk-verify/user-data"
```

`--noSandbox` is the verification Linux/container path. It is not a product change. `--remoteDebuggingPort` is electron-vite's flag; it becomes Electron `--remote-debugging-port`.

**Ready:** `doctor` exits 0. Under the hood that is CDP `http://127.0.0.1:9333/json/list` showing a page target whose URL is the Vite renderer (usually `http://localhost:5173/`) and whose document contains `.app`. Launch waits up to 90s.

**Do not** use the user's real data dir. **Do not** attach to a Gronk the user already has open. **Do not** store, log, or forward CLI tokens.

Dev opens detached DevTools. Drive the page target titled `Gronk`, not `devtools://`.

## Doctor

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs doctor
```

Read-only. Run it first whenever anything looks off. It answers: did we start this process, is it alive, do we own the CDP port, is userData disposable (not the default `gronk` dir), and is the renderer a Gronk `.app`? Exit 0 only when all of those hold.

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs info
```

prints the instance file (pid, ports, userData, log path) without probing the page.

## Drive

Recipe: `control-gronk.mjs` over CDP. Prefer button text, `aria-label`, `aria-current`, `aria-pressed`, and the CSS handles below — not coordinates.

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs click --text "Chat" --within .home-actions
node .cursor/skills/verify-gronk/control-gronk.mjs click --text "Build" --within nav[aria-label="Main"]
node .cursor/skills/verify-gronk/control-gronk.mjs click --text "Focus"
node .cursor/skills/verify-gronk/control-gronk.mjs click --selector ".brand"
node .cursor/skills/verify-gronk/control-gronk.mjs press --key "["
node .cursor/skills/verify-gronk/control-gronk.mjs wait --text "Grok on your desktop"
node .cursor/skills/verify-gronk/control-gronk.mjs eval --js "document.querySelector('.topbar-kicker')?.textContent"
```

Stable handles from this tree:

| What | Handle |
| --- | --- |
| Shell | `.app` ; Focus adds `.app.focus-mode` |
| Home brand (go Home) | `button.brand` (`title="Home"`, `aria-current="page"` when Home) |
| Chat / Build rail | `nav[aria-label="Main"]` `.nav-item-label` text `Chat` or `Build` (the subtitle is extra text; `--text Chat` matches the label child) |
| Home landing | `.home-view` ; kicker `.home-kicker` = `Home` ; `h1` contains `Grok on your desktop` |
| Home Chat / Build | `.home-actions` buttons `Chat` (primary) and `Build` (secondary) |
| Chat browse | `.browse-home` kicker `Chat` ; `h1` contains `Talk with Grok` |
| Build browse | `.browse-home` kicker `Build` |
| Focus | topbar button text `Focus` / `Exit focus` (`aria-pressed`) ; key `[` when focus is not in an input |
| Auth overlay | `[role="dialog"][aria-modal="true"].auth-overlay` ; no dismiss when signed out |
| Permission | `[role="dialog"]` `.modal-permission` (`data-kicker="PERMISSION"`) ; **Deny** is the primary button |
| YOLO confirm | heading `Enable bypass permissions?` ; **Keep gated** / **I understand, enable it** |
| Search | `aria-label="Search every session by title or message text"` (hidden on Home) |
| Heatmap | `.calendar-panel` ; scope group `aria-label="Show activity for"` (`All` / `Chat` / `Build`) |
| Onboarding | `aria-label="Getting started"` ; **Hide** |

`click` refuses when a modal (`.auth-overlay` or `[role=dialog][aria-modal=true]`) is up and the target is not inside it. A DOM `.click()` would go through; a person cannot. If the overlay has no `Continue to app` button, stop and snapshot the overlay.

`eval` is for reading state after a user action. Do not call `window.gronk.*` as the proof.

Read [`features/README.md`](features/README.md) and the matching feature file before driving. A proof that only opens the window is incomplete when the map lists other entry points.

## Evidence

Default directory (survives cleanup, not committed):

```
artifacts/verify-gronk/
```

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs screenshot --path artifacts/verify-gronk/home.png
node .cursor/skills/verify-gronk/control-gronk.mjs snapshot --path artifacts/verify-gronk/home.aria.txt
```

Proof standards:

- Drive the real window, not `__shots.html`, not the fake `window.gronk` in `src/__shots.tsx`, not test-only endpoints.
- Capture the action and the resulting state (before click + after), not only the last frame.
- Name the feature id and entry point in the artifact filenames (`home-hero-chat.png`, not `shot.png`).
- Side effects: after Chat/Build navigation, the topbar kicker and the browse kicker must agree (`Chat`/`Build`). After Focus, `.app.focus-mode` is present and `nav[aria-label="Main"]` is not displayed.
- Mocks only where a production boundary already isolates the system: `npm run test:visual` is that gallery. It does not prove this skill.
- Do not re-record `tests/visual/baseline` from this skill. Issue #111 is a known false positive that drifts red on its own. Read the magenta in `tests/visual/diff/` before anyone updates a baseline.
- Auth and tokens: never print CLI credentials, `XAI_API_KEY`, or store contents that look like keys. Doctor and snapshots should show "Signed in" / "Not signed in", not secrets.

## Cleanup

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs cleanup
```

Kills **the pid/process group recorded at launch**, then deletes `$TMPDIR/gronk-verify/` (userData, pid file, launch log). Does **not** delete `artifacts/verify-gronk/`. Does **not** kill by process name (`electron`, `Gronk`). After cleanup, confirm the evidence files still exist.

If launch failed halfway, still run cleanup so ports and the Vite server are not stranded.

## Helpers

All of these are the same script:

```bash
node .cursor/skills/verify-gronk/control-gronk.mjs --help
node .cursor/skills/verify-gronk/control-gronk.mjs paths
node .cursor/skills/verify-gronk/control-gronk.mjs launch
node .cursor/skills/verify-gronk/control-gronk.mjs doctor
node .cursor/skills/verify-gronk/control-gronk.mjs info
node .cursor/skills/verify-gronk/control-gronk.mjs wait --text "Grok on your desktop"
node .cursor/skills/verify-gronk/control-gronk.mjs click --text Chat --within .home-actions
node .cursor/skills/verify-gronk/control-gronk.mjs screenshot --path artifacts/verify-gronk/home.png
node .cursor/skills/verify-gronk/control-gronk.mjs snapshot --path artifacts/verify-gronk/home.aria.txt
node .cursor/skills/verify-gronk/control-gronk.mjs cleanup
```

`paths` prints default userData (refused), scratch, evidence, CDP port. Use it when doctor looks wrong.

## Complementary checks (do not skip, do not substitute)

| Command | What it proves | What it does not |
| --- | --- | --- |
| `npm test` / `npm run typecheck` | Logic, IPC guards, jsdom | A real window |
| `npm run test:visual` | 38 gallery states vs baseline | Live Electron + real store/CLI |
| `npm run test:preview` | Preview pane under Electron | Home/Chat/Build/Focus |
| This skill | Live renderer, user clicks | CLI protocol, cost, sandbox claims |

`GRONK_LIVE_CLI=1 npm test` is the CLI/ACP canary. It is not a UI proof.

## Hard rules this skill must not break

- No new `ipcMain.handle` from this skill. If a later change adds one, `assertTrustedSender` first and a validator from `ipc/validate.ts` before use.
- Never skip `--permission-mode` on the grok child (this skill does not spawn `grok`).
- Do not claim the grok child is OS-sandboxed to the project folder.
- Model output stays inert. Snapshots are text and PNG, not HTML rendered as HTML.

## Feature map

[`features/README.md`](features/README.md) — Home, Chat, Build, Focus, permission prompts.

## Maintenance

`/maintain-verification-skill` when Home/Chat/Build/Focus/permission UI changes. Do not "fix" a product bug by editing the map to match the bug.
