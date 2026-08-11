# Changelog

Notable changes to Gronk. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-11

Two things happened in this release. Sessions stopped being one-at-a-time, and the
transcript stopped living in one file that got slower the bigger it grew. Most of
the rest follows from those.

### Before you install this

**Do not go back to 0.3.0 or earlier after running this.** Conversations move out
of `gronk-store.json` into one file each, and the store is rewritten without them.
Older versions read the conversation out of the store, so they would show every
session as empty. Nothing is destroyed — the files are still there and this version
reads them — but anything said while downgraded is written where this version no
longer looks.

### Added

- **Sessions keep running when you look at another one.** Clicking a different
  session used to end the work you walked away from. Several can now run at once,
  the sidebar marks which are working and which are waiting on you, and each row can
  be stopped on its own. Coming back to one shows what it actually says rather than
  what was half-drawn when you left.

- **A message typed while the agent is working is queued instead of refused.** Send
  used to be disabled for the whole turn, so a finished message sat in the box
  waiting for an end you cannot see coming. Queued messages are shown in full, each
  cancellable, and they go in order as turns finish. Stopping a turn holds them
  rather than releasing the next one — stopping usually means you want to say
  something different — and the button says so.

- **What you have typed stays with the conversation you typed it in.** Leaving the
  conversation view used to throw an unsent message away, and switching sessions
  carried it into the next conversation, one Enter from the wrong agent. Drafts are
  kept per conversation, including one typed before the agent has finished starting.
  They do not survive quitting the app.

- **A Changes panel** showing what the agent altered in the open folder.

- **Project notes**, plain text, one per folder, kept with Gronk's own settings
  rather than in the project.

### Changed

- **The transcript store no longer grows without bound.** Conversations live in one
  file each, so opening a session reads that session rather than everything ever
  said. A real store had reached 120 MB, most of it duplicated tool calls that were
  re-appended on every reopen, and parsing it froze the window for about a minute on
  every read. The duplicates are removed on first launch and cannot re-accumulate.

- **The store is read once per operation rather than eighteen times.** A single turn
  was re-reading and rewriting the whole file repeatedly; a permission decision
  rewrote it as well, and the audit log now has its own file.

- **Chat and Build have the same shape.** They were two different layouts for the
  same job, and the sidebar now says what each one is for.

- **The window can be dragged by the header** again, without the click-to-dismiss
  behaviour that first fix broke.

### Fixed

- **A transcript save cannot replace a conversation with a shorter, different one.**
  This is the fix for real data loss: reopening a session after a restart could
  overwrite its history with a partial copy. A save that would drop stored messages
  is refused, and the surviving history is kept.

- **Attached images survive relocating the data folder**, and parked attachments are
  collected once nothing refers to them — with the collector refusing to act when it
  cannot be sure.

- **A stalled browser sign-in no longer disables device-code login.** The wait
  switched off the exact remedy the screen recommends, and restarting the app was the
  only way out.

- **A rejected agent call says which call failed.** The CLI reports some failures —
  including a spent weekly plan quota — as a bare JSON-RPC error whose standard name
  is "Internal error", and that is all the banner used to show. It now names the call
  and the code, keeps the agent's own reason when there is one, and for that specific
  empty error suggests checking Grok usage limits first.

- **A turn that fails before the agent says anything no longer leaves a blank message**
  in the conversation, or on disk. Each failed attempt used to add another.

- **Reading an older part of a conversation is no longer interrupted by the restore
  finishing.** Scrolling and typing are allowed while a session loads, and on a large
  one that takes long enough to start reading — then the moment it finished, the view
  was dragged back to the newest message. Only something you just did moves the view
  to the end now.

- **The error banner stays about what is failing now** rather than the last thing that
  failed.

- **Events are attributed to the session they belong to**, so a background session
  cannot narrate over the one on screen.

- **The account label never surfaces an email address.**

- **The usage panel says "reused" where it shows the cache share.** A large number
  with a bare percentage beside it reads as a fuel gauge; it means the opposite. The
  panel also says plainly that it cannot see a plan's quota — a spent weekly limit
  arrives as a failed turn, not as a warning there.

## [0.3.0] - 2026-08-05

Almost all of this is the same complaint from several directions: Gronk got
slower the longer a conversation ran, and the causes turned out to be unrelated
to each other.

### Changed

- **Streaming no longer re-reads the whole conversation on every word.** Each
  token rebuilt the message list, so every message on screen re-ran its markdown
  parse — about 40 ms of parsing per token in a 150-message thread, which is what
  made the chat feel like it was seizing. Only the part that actually grew is
  re-parsed now, measured at about 0.24 ms for the same token. The agent panel
  also stopped re-scanning the transcript on tokens that contained no tool
  activity, which was a second full pass on top of the first.

- **Reopening a session shows you the end of it immediately.** The whole
  transcript used to render before anything appeared. The last stretch now paints
  first — which is where you were reading anyway — and the rest fills in behind
  without holding the keyboard. Sessions you have already opened are kept in
  memory, so flipping between two of them does not re-read either from disk.

- **Answering a permission prompt no longer rewrites your whole store.** The
  permission audit lived inside `gronk-store.json`, so every decision re-read,
  re-serialized and re-wrote every stored transcript before the app could
  continue — and in auto-approve mode that happened on every tool call, not just
  the ones you clicked. The audit has its own file now.

- **The Build panel is the session list.** Flat and newest-first by default, with
  a control to group by project instead. Reaching a conversation no longer means
  walking a hierarchy first.

- **The activity chart loads when you visit Home** and stays painted when you
  navigate away, instead of rebuilding from every stored transcript each time a
  turn finished.

### Added

- **A scratchpad per project**, in the tray above the composer. It belongs to the
  folder rather than to a session, so it outlives a project dropping off the
  recent list. The tray shows a word count rather than a preview, because that
  rail is on screen for the whole session and a scratchpad is where you park the
  thing you did not want on display.

- **Click a day on the activity chart** to filter the session list to that day.
  Transient: it clears with the chip and is not remembered between launches.

- **The sidebar footer says which build you are running** — version, channel and
  commit — so a bug report can name the build it came from.

### Fixed

- **The selected session row actually highlights.** The rule that styled it never
  matched the class the row emitted, so the open conversation looked identical to
  every other one in the list.

- **A wrong "signed in" state can be corrected.** If the app believed you were
  signed in when you were not, Settings hid both login buttons behind that belief
  and there was nothing left to press. Sign-in stays reachable either way, and
  the sidebar account chip is now a button. Changing the grok binary also drops
  the cached auth and model answers, which were still describing the previous
  one. Thanks to [@0xPBIT](https://github.com/0xPBIT) for finding and fixing this.

- **A successful `grok models` is no longer treated as evidence of an account.**
  It only proves the CLI runs.

- **Clicking the session you are already in no longer rebuilds it**, and the
  agent tab no longer presents a restored session's entire history as current
  work.

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

- **Focus mode.** A topbar button or the `[` key hides the sidebar and idle
  tray so the conversation fills the frame.
- **The agent tray keeps session history.** Finished agents stay listed until
  dismissed, instead of the tab vanishing the moment work stops.

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
- **Sign-in state is honest.** A successful model list no longer counts as
  being signed in: the CLI answering is necessary, not sufficient, so a fresh
  install reads as signed out until something positively indicates an account,
  and signing out no longer flips straight back. If an environment API key is
  still answering after sign-out, the app says so by name.
- **Scrolling holds when a reply finishes.** The end of a turn shortens the
  transcript, and the browser's scroll clamp used to read as "the reader came
  back to the bottom", snapping them down. A scroll nobody made no longer
  re-attaches.
- **Sign out lives in Settings only**, next to the account it acts on, instead
  of a top-level sidebar button.
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

[0.3.0]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.3.0
[0.2.0]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.2.0
[0.1.8]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.8
[0.1.7]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.7
[0.1.6]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.6
[0.1.5]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.5
[0.1.3]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.3
[0.1.2]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.2
[0.1.1]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.1
[0.1.0]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.0
