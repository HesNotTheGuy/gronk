# Changelog

Notable changes to Gronk. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Streaming responses with markdown, code blocks and syntax highlighting.
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

[0.1.0]: https://github.com/HesNotTheGuy/gronk/releases/tag/v0.1.0
