# Changelog

Notable changes to Gronk. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-04

### Added

- **A right-click menu.** Electron ships none, so right-clicking anywhere in
  Gronk used to do nothing at all: no cut, copy or paste, and the spelling
  suggestions Chromium was already computing sat under the red underline with no
  way to reach them. Editable fields get Cut, Copy, Paste and Select All, enabled
  from Chromium's own flags rather than from guessing. A misspelling puts its
  corrections above the editing verbs, since that is what you right-clicked the
  underline for. A link offers Copy link, and only Copy link: nothing here opens
  anything.

### Changed

- **Agent activity is a row of dots under the turn that started it**, instead of
  a grid of bordered chips. One dot per agent: dim when it finished, red when it
  failed, pulsing while it runs. A failure is now visible without reading
  anything, where before every chip carried the same border and the same weight
  so a failed one looked like the five beside it. The full list is still one
  click away in the tray.
- **The agent panel no longer opens itself.** It used to appear the moment work
  started, pushing the transcript while you were mid-sentence. The tab already
  says how many agents are live, and the dots say the same thing in place.

### Fixed

- **Scrolling no longer fights you while a reply streams.** Scrolling up a line
  or two to re-read something was undone by the next token: leaving the bottom
  and returning to it shared one threshold, so a small deliberate scroll read as
  "still near the end, re-pin". Leaving is now honoured instantly at any
  distance, and only actually arriving at the bottom re-attaches. Keyboard and
  scrollbar scrolling count as leaving too, which they never did.
- **Tool output no longer fills the screen with image previews.** Any image path
  that merely appeared in a tool's output was rendered as a full-size preview
  with no limit, so listing a folder of icons buried the reply. Previews are now
  for tools that actually produce images, and the row is capped.
- **macOS builds ship the Electron and Chromium licences again.** The packaged
  app pointed at a directory that release builds never populate, and the missing
  files were skipped silently.

### Internal

- CI can be run on demand, and its four-platform matrix has now run for the first
  time; macOS had never executed the suite before.
- The dependency scanner refuses a malware dataset below a floor instead of
  printing OK when it receives an empty one.
- Screenshot fixtures use a frozen clock, so visual baselines stop drifting daily.
- `CONTRIBUTING.md` describes what CI actually does rather than what it was
  configured to do.

## [0.1.9] - 2026-08-03

### Changed

- **Tool activity is a single line you can expand, instead of several things
  pulsing at once.** While Grok worked, the agent fleet indicator and the
  "Using SHELL" row animated independently, which read as two separate systems
  doing two separate things. They are now one summary bar showing whatever is
  actually running, with the detail behind a click.
- **Long paths and commands in that bar are shortened to fit.** A line that ran
  past the width of the bar is trimmed rather than pushing the layout around.

## [0.1.8] - 2026-08-03

### Added

- **A single session tray** above the composer for Plan, Agents, and Usage.
  One thin rail of tabs instead of three stacked panels eating the chat.
- **Command palette** (Ctrl/Cmd+K) to jump Home, Chat, Build, settings, and more.
- **Pin and remove recent projects** from the project menu (remove only forgets
  the list entry; it never deletes files on disk).
- **Opening a project resumes the latest session** for that folder. Use
  **New session** when you want a blank conversation.
- **Chat skeleton** while a project or session is opening, so the window has
  structure instead of looking frozen during agent boot.
- **Allow this kind for session** on permission prompts: batch-approve a tool
  kind for the rest of this agent process without turning on full YOLO.
- **OS notifications** when the window is unfocused and a permission is needed
  or a turn finishes.
- **First-run onboarding checklist** on Home (CLI, sign-in, first project) using
  the existing install and login paths.
- **Status menu** in the top bar: connection, account, and model in one control
  instead of three separate pills.

### Changed

- **Light theme** reworked as paper and ink rather than an inverted night mode.
  The Windows title-bar overlay follows light and dark.
- **Wider message column** and a tighter top bar so conversation fills more of
  the pane.
- **Agents tab** only appears when something is live, not a pile of finished
  tool calls on a restored transcript.
- **Missing images** fail more quietly (compact rows, faster skip of fake/remote
  paths) so a bad catalogue cannot own the viewport.
- **Session restore** paints the local transcript in one shot, then connects the
  agent, instead of thrashing the UI message by message.

### Fixed

- **Code block and message Copy** now write to the system clipboard (they failed
  silently before under the permission lockdown).
- **Permission dialogs** for large execute payloads keep Deny / Allow on screen;
  the payload scrolls inside the dialog.
- **Streaming no longer fights your scroll position** when you read earlier in
  the thread.
- **Activity heatmap date** no longer shifts every evening because of a UTC vs
  local day mismatch in the shots fixture (and related calendar anchoring).

## [0.1.7] - 2026-08-02

### Fixed

- **Images could be refused from a folder that was allowed.** An image the agent
  referred to was checked against a list of permitted folders, but one side of
  that comparison followed shortcuts on disk and the other did not, so a folder
  reached through one never matched. The result was "Path outside allowed image
  roots" for a file that was genuinely inside a permitted folder. macOS was most
  affected, since its temporary folder is reached that way by default.

## [0.1.6] - 2026-08-01

### Added

- **The preview pane resizes.** Drag the divider between the conversation and the
  dev-server preview to give either side more room.
- **Pop the preview into its own window.** Useful on a second monitor. Closing
  that window puts the preview back in the pane and leaves the dev server
  running. The detached window keeps every restriction the pane has: sandboxed,
  locked to localhost, no bridge to the agent, and its own throwaway session that
  writes nothing to disk.

### Changed

- **Images from the model are never fetched.** A remote image in a reply now
  renders as a link showing the host it points at, so you decide whether to open
  it. Loading one automatically would have told that server you had read the
  message, and a unique URL per reply turns an image tag into a tracking pixel
  that also leaks your IP. Images the model generates still render inline, and
  images served by your own dev server are unaffected.

### Fixed

- **Stopping a popped-out preview no longer flashes "running".** Teardown
  destroyed the detached window in a way that immediately rebuilt the pane it was
  removing, reporting the dev server as alive for a moment after it had been
  stopped.
- **The preview survives a window reload.** The pane read its state only from
  live events, so after a reload the app believed nothing was previewing while
  the dev server was still up.

## [0.1.5] - 2026-07-30

### Added

- **Your skills are visible.** A Skills tab lists every skill on this machine —
  the ones you added and the ones bundled with the Grok CLI — with the
  description each one declares. A skill is a folder containing `SKILL.md`;
  dropping it into `~/.grok/skills` is the entire install, and the tab says so.
- **Session actions in the sidebar.** Rename, Archive, Export and Delete now sit
  behind a menu on each row, including search results. They were previously
  reachable only from the browse screens.
- **Plugins & Skills has its own entry** in the sidebar, instead of being buried
  inside Settings.
- **Plugins show where they came from.** Each card now displays the account that
  published it, such as `github.com/xai-org`, beside the marketplace's own name.

### Changed

- **A marketplace name is no longer treated as a credential.** It was shown as a
  badge, but that name is a string anyone can set — including to "xAI Official".
  It is now a plain label, and the publishing account sits next to it, because
  that is the part that cannot be claimed without controlling it. Gronk marks
  nothing as verified, since it has no way to know.

### Fixed

- **A failed plugin install showed no reason.** The error was set and then
  immediately cleared by the refresh that followed it, so every failed install,
  enable, disable and uninstall reported a message that never reached the screen.
- **Search counted results it would not show.** Archived sessions matched and
  were counted in the header, then dropped from the list underneath.
- **Search re-read your entire history on every keystroke**, once per session.
  It now reads once per query.
- **Generated images were unreachable if you relocate the Grok CLI** with
  `GROK_HOME`. Two places rebuilt the CLI's home by hand and ignored the
  override, so the app looked in a directory the CLI was not writing to.
- **A new session appeared in the sidebar only after its first reply finished**,
  so the list said "no sessions yet" while you were sitting in one.
- **Switching away mid-reply severed the turn.** The agent is now told to stop
  before its process is closed, so it ends deliberately instead of losing the
  connection mid-sentence.
- Skill descriptions written in the common multi-line YAML style are read
  properly instead of appearing as a single `>`.

## [0.1.3] - 2026-07-30

### Added

- **Search every session** by title or message text, across Chat and Build
  together, from the sidebar. Agent reasoning is searched too, because it often
  names the file the visible answer only alludes to. Results say where they
  matched and which surface they came from.

### Fixed

The preview pane was hardened for security in 0.1.2 but its actual operation had
never been exercised. Six defects, all measured rather than inferred:

- **The pane could never find some dev servers.** The URL scan ran on the
  redacted copy of the output, so a server printing its own address with a query
  string had that address mangled before it was matched. And the capture pattern
  stopped only at whitespace, so `App running at http://localhost:3000.`,
  `(http://localhost:3000)` and a markdown `[url](url)` all produced something
  unparseable — after which the pane waited forever with no error.
- **Stopping the preview could leave the dev server running.** A tree kill
  breaks when an intermediate process exits, which is exactly what `npm run dev`
  does when it hands the server to a detached grandchild; the port stayed bound.
  A port sweep now follows, and POSIX escalates to SIGKILL.
- **A failed kill could crash the app.** The guard around it could not catch the
  error it was guarding, which arrives asynchronously and became an unhandled
  exception in the main process.
- **A stopped pane could come back**, and a failed start left the pane reporting
  "running" forever with no process behind it.

Plugins:

- **The trust dialog said "Pinned commit" when nothing was pinned.** The install
  never received that commit and never checked it afterwards. The label now says
  what the value is and states that the install is not pinned to it.
- **A plugin source could specify any scheme.** The https-only check covered
  catalog entries read from disk but not ones arriving from the CLI, so a
  marketplace listing could name a local file or an ssh target and have it
  installed. The check now sits at the install itself.
- **A successful install could empty the Installed list**, when the follow-up
  read of the plugin list could not be parsed.

## [0.1.2] - 2026-07-28

### Fixed

- **Light mode was unusable.** Twenty-four elements were unreadable, several at
  a contrast ratio of 1.03:1 — text the same colour as the surface behind it.
  Twenty-seven rules painted their own black background, so no theme could reach
  them: the palette flipped, the text turned dark, and the surfaces stayed dark.
  The accent and the state colours were never overridden either. Now measured at
  zero failures across five views, with dark verified unchanged.
- **The usage meter claimed you had spent money you had not.** It read
  "~$0.28 est." on every session. That figure is only a charge when you sign in
  with an API key; with a Grok account nothing is billed per token and the same
  number is a notional API-rate equivalent. Dollars now appear only when they
  are real, labelled "At API rates" otherwise. Token counts are unchanged.

### Changed

- **The sidebar is now a navigator that stays put.** Choosing Build shows your
  projects immediately, rather than after you had already opened one. Switching
  projects no longer means leaving the session you are in.
- **One word for a project.** "Folder" and "workspace" both meant the same thing
  as "project" in different corners of the interface. A *project* is a directory
  the agent works in; a *session* is one conversation. "Workspace" is gone.
- "Open folder…" is now "＋ Add project", since every existing project is
  already listed. The paired "All" button and the Sessions rail's empty state
  are gone, which is a row of buttons and a dead panel reclaimed.

## [0.1.1] - 2026-07-27

### Fixed

- **The activity heatmap was invisible.** It had no stylesheet at all, so every
  one of its day cells rendered at zero height and the panel showed only its
  month and weekday captions, bunched together as plain text. The component
  itself was correct; `src/styles.css` simply never contained a single
  `.calendar-*` rule, in this release or any before it. Anyone who installed
  0.1.0 saw a blank space where the heatmap should be.

### Added

- A test that fails when a component uses a class the stylesheet does not
  define. The existing tests covered the calendar's data and passed throughout,
  because the data was never what was broken.

## [0.1.0] - 2026-07-26

First public release. Everything before this was pre-release development in a
private repository, so there is no earlier entry to compare against.

### Added

- Desktop client for the Grok Build CLI, run as a child process over ACP
  (`grok agent stdio`). No backend, no bundled credentials, no model calls of
  its own.
- Three surfaces: Home for recent projects and activity, Chat for conversation,
  Build for a coding agent scoped to a project folder. Chat uses the same ACP
  path as Build with a sandbox working directory, so it never enters your
  project list.
- Sign-in gate. Nothing runs until the CLI reports an authenticated account.
- Streaming responses with markdown, and code blocks with a copy button.
- Tool call cards, with diffs for edits.
- Permission prompts that show the actual diff or command before you approve,
  plus permission modes and a per-session model picker.
- Token and cost accounting per session.
- Activity heatmap covering your own work.
- Plugins, skills and MCP servers, managed from Settings.
- Session restore, rename, archive and export.
- Attached preview for a dev server you are already running.
- File mentions, image paste, drag and drop.
- Relocatable data directory. The store moves from Settings, and an install
  under an older directory name is adopted rather than abandoned.
- Installers for Windows, macOS and Linux, built in CI.

### Security

- `contextIsolation: true` and `nodeIntegration: false`. The renderer gets a
  typed `window.gronk` bridge and no Node access.
- Every IPC handler validates its sender before doing anything else, and
  validates its arguments.
- Filesystem access from the agent is confined to the project directory,
  enforced on the resolved real path so symlinks cannot escape it.
- Credentials stay with the Grok CLI. Gronk never stores a token and never
  forwards one to the renderer.
- Dependency installs run with lifecycle scripts disabled and are scanned
  against a known-malware dataset. See
  [docs/supply-chain.md](docs/supply-chain.md).

### Known limitations

- Tested on Windows. The macOS and Linux builds are produced by CI but have not
  been run by the author.
- Installers are unsigned, so both Windows SmartScreen and macOS Gatekeeper will
  warn on first launch.
- No automatic updates. Code signing has to land first.

[0.1.8]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.8
[0.1.7]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.7
[0.1.6]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.6
[0.1.5]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.5
[0.1.3]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.3
[0.1.2]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.2
[0.1.1]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.1
[0.1.0]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.0
