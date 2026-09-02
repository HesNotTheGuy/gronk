# Build

Build points Grok at a folder on this computer. Folders and their sessions live here, grouped, not on Home. The agent can read, edit, and run what is inside that folder after the user approves tools.

## Sub-features

- `build-browse` shows the Build home (kicker `Build`).
- `build-from-home` reaches it from the Home hero **Build** button.
- `build-from-rail` reaches it from the sidebar **Build** item.
- `build-empty` on a fresh profile has no folders yet.
- `build-open-folder` (signed in) uses the folder picker — native OS dialog; the CDP driver cannot complete it.

## How to get to it (user POV)

- On Home, press **Build**.
- In the sidebar, press **Build**.
- Click a heatmap day on Home (that switch is defined to land on Build).

## Driving it with control-gronk

Preconditions:

- Doctor is green.
- Auth overlay gone, or you are only proving that Build is blocked by it.

- **From Home.** Run `control-gronk.mjs click --text Build --within .home-actions`. Topbar kicker is `Build`. Main kicker is `Build`. Heading / copy talk about projects or folders, not `Grok on your desktop`.
- **From the rail.** `control-gronk.mjs click --text Build --within nav[aria-label="Main"]`. Same Build browse.
- **Catalog ownership.** Folders and sessions, when any exist, appear on this surface. They must not appear on Home. A fresh userData dir showing no folders is expected.
- **Native picker.** A control that opens the OS folder dialog is not completable over CDP. Report `build-open-folder` as skipped with the button you pressed. Do not invent a cwd via `eval`.
- **Proof.** `artifacts/verify-gronk/build-browse.png` and `.aria.txt` with kicker `Build`. Home heading `Grok on your desktop` is gone.

## Gotchas

- Preview (`▶ Preview`) only appears in an open Build conversation, not on Build browse. `npm run test:preview` covers the preview host. Do not require Preview to call Build browse verified.
- Permission mode (`aria-label="Permission mode"`) is a Build-session control. Changing it on a live project can restart the agent. Settings describe the next session; the running session is the one on screen.
- Do not claim the grok child is OS-sandboxed to the folder. ACP fs helpers are jailed; approved tools (and YOLO) run as the user.
- Opening a real project and sending a turn can edit the machine and cost money. Stay on browse unless the task asked for a live agent.
