<div align="center">

<img src="build/icon.png" width="112" alt="">

# Gronk

**Grok on your desktop.**

Your projects, your sessions, your history, in a window instead of a terminal.

[![CI](https://github.com/HesNotTheGuy/gronk/actions/workflows/ci.yml/badge.svg)](https://github.com/HesNotTheGuy/gronk/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/HesNotTheGuy/gronk?include_prereleases&label=release)](https://github.com/HesNotTheGuy/gronk/releases/latest)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

[Download](#download) · [What it does](#what-it-does) · [Security](#security) · [Build from source](#build-from-source)

</div>

![Gronk Home with the rock brand mark, pure-black chrome, Focus in the topbar, an activity heatmap, and recent projects](docs/images/home.png)

> [!NOTE]
> **Every release ships installers for Windows, macOS and Linux.** Day-to-day
> development is Windows-first; the macOS and Linux builds come from CI and get
> less hands-on use — please report anything that only fails there.

## Download

**[Get the latest release](https://github.com/HesNotTheGuy/gronk/releases/latest)**
for Windows, macOS and Linux.

| Platform | File |
|---|---|
| Windows | `Gronk.Setup.<version>.exe` to install, or `Gronk.<version>.exe` to run without installing |
| macOS | `Gronk-<version>-universal.dmg`, Apple Silicon and Intel |
| Linux | `Gronk-<version>.AppImage`, or `gronk_<version>_amd64.deb` |

Installers are unsigned, so your OS will warn you on first launch. On macOS,
right-click the app and choose **Open**. On Windows, click **More info** then
**Run anyway**. `SHA256SUMS.txt` on the release verifies the download arrived
intact, which is integrity rather than authorship.

## What it does

Gronk runs your local `grok` binary as a child process and talks to it over ACP.
No backend, no bundled credentials, no model calls of its own. You sign in with
your own Grok account. Sign out lives in Settings, next to the account it acts
on.

There are two surfaces, and the difference is whether your files are involved.

| | |
|---|---|
| **Chat** | A conversation. No project folder, so nothing reads or edits your files. |
| **Build** | Grok pointed at a folder on your computer, where it can read, edit and run. |

The shell is pure black with the rock brand mark in the rail. **Focus** (topbar
button, or `[` when you are not typing in a field) hides the sidebar and the idle
session tray so the conversation fills the frame.

### Watch the agent work

Every tool call becomes a card. Reads, edits and shell commands, with diffs.
Spawned agents show as a row of status dots under the turn that started them:
dim when finished, red when failed, pulsing while live. The Agents tab in the
session tray keeps that history until you dismiss it, and no longer opens itself
when work starts.

![A Build session with pure-black chrome, the rock mark, Focus in the topbar, and tool call cards for read, edit and shell](docs/images/build.png)

### Approve before anything runs

Edits show you the diff. Commands show you the command. Deny is the default
button, and the dialog tells you when text came from the model rather than from
Gronk.

![A permission prompt showing a diff, with deny and allow options](docs/images/permission.png)

### Find any conversation

Search titles and message text across Chat and Build at once. Results say where
they matched and which surface they came from.

![Sidebar search with pure-black chrome, the rock mark, Focus in the topbar, and results with matching snippets](docs/images/search.png)

### See your skills

Every skill on your machine, yours and the ones bundled with the CLI. A skill is
a folder containing `SKILL.md`. Dropping it into `~/.grok/skills` is the whole
install.

![The Plugins and Skills panel, reached from Settings](docs/images/skills.png)

### Know where a plugin came from

Plugin cards show the account that published them, like `github.com/xai-org`.
A marketplace name is a string anyone can set, so it is shown as a plain label
and never as a badge. Gronk marks nothing as verified, because it cannot know.

![Plugin cards on the Installed tab showing publisher origins](docs/images/plugins.png)

### Also

|  |  |
|---|---|
| **Activity** | A heatmap of your own work, and cost accounting per session |
| **Sessions** | Restore, rename, archive, export |
| **Preview** | A dev server attached beside the conversation, resizable or popped out |
| **Extensions** | MCP servers, plugins and skills, managed in app |
| **Input** | File mentions, image paste, drag and drop |
| **Themes** | Light and dark |

## Requirements

1. **The Grok CLI**, on your PATH.
   - Windows: `irm https://x.ai/cli/install.ps1 | iex`
   - macOS and Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
2. **Your own Grok account.** Sign in from Gronk, or run `grok login`.

Node.js is not required. The installer bundles its own runtime.

## Security

- `contextIsolation: true`, `nodeIntegration: false`. The renderer gets a typed
  bridge and no Node access.
- Every IPC handler checks its sender before doing anything else.
- Agent file access is confined to the project directory, enforced on the
  resolved real path so symlinks cannot escape.
- Credentials stay in the Grok CLI. Gronk never stores or forwards a token.
- Dependencies install with lifecycle scripts disabled and are scanned against a
  known-malware dataset. See [docs/supply-chain.md](docs/supply-chain.md).

Your conversations are stored on your machine as readable text, which is what
comparable tools do. Do not paste secrets into a chat.

## Build from source

Needs **Node.js 22.18 or newer** for the test runner's native type stripping.

```bash
npm ci --ignore-scripts
npm run dev
```

Or use the guarded install, which disables lifecycle scripts, scans what landed,
then fetches only the Electron binary:

```bash
npm run setup
```

Bare `npm install` is discouraged. npm supply chain worms run in lifecycle
scripts.

```bash
npm run verify      # typecheck and tests
npm run dist:win    # installers, per platform
```

macOS installers can only be built on macOS. Run the "Build installers" workflow
from the Actions tab if you do not have one.

### Checks that need a screen

`npm run verify` runs in CI on every push. These two need a display, so they run
locally before a release:

```bash
npm run test:visual     # render 38 app states, compare against the baseline
npm run test:preview    # drive the dev-server preview under real Electron
```

`test:visual` exists because the rest of the suite cannot see the screen. The
activity heatmap once shipped with no CSS at all and every test passed, because
they asserted its data and the data was correct. When a state changes, look at
the magenta regions in `tests/visual/diff/`, then accept it with
`npm run test:visual:update` if the change was intended.

Baselines are rendered by one machine's font stack, so comparing them on a
different OS reports differences that are not regressions. Close every other
Gronk window before running the harness: it drives by clicking text, and a live
app window will receive those clicks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

You may use, modify and ship Gronk commercially, including in closed source
products. The licence does not grant rights to the Gronk name or logo.

**The Grok CLI is not part of Gronk and is not redistributed here.** Gronk
launches whichever binary you installed yourself, under xAI's terms, with your
own account.

Gronk is an independent project, not affiliated with or endorsed by xAI. "Grok"
is a trademark of xAI, used here only to describe what this app connects to.

Bundled packages are credited in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
