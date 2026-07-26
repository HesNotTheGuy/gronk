# Gronk

A desktop app for the [Grok Build CLI](https://x.ai). It runs your local `grok`
binary as a child process and talks to it over ACP (`grok agent stdio`).

Gronk is a client, not a service. It has no backend, ships no credentials, and
never calls a model itself.

> **Status: pre-release.** Tested on Windows. macOS and Linux builds have not
> been run yet. Reports welcome.

## What it does

| Surface | Purpose |
|---------|---------|
| Home | Recent projects, sessions, activity |
| Chat | General conversation, backed by the CLI |
| Build | Coding agent in a project folder |

Chat is not a web wrapper. It uses the same ACP path as Build, with a
conversational system prompt and a sandbox working directory, so it never
appears in your project list.

## Requirements

1. **Node.js 22.18 or newer.** The test runner relies on native TypeScript type
   stripping, which older versions lack.
2. **The Grok CLI**, installed and on your PATH.
   - Windows: `irm https://x.ai/cli/install.ps1 | iex`
   - macOS and Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
3. **Your own Grok account.** Sign in from Gronk's sign-in screen, or run
   `grok login`.

## Running it

```bash
npm ci --ignore-scripts
npm run dev
```

On Windows, prefer the guarded installer, which installs with scripts disabled,
scans, then fetches only the Electron binary:

```powershell
npm run safe-install
```

Bare `npm install` is discouraged. npm supply chain worms run in package
lifecycle scripts. See [SECURITY.md](SECURITY.md).

## Building installers

```bash
npm run dist:win
npm run dist:linux
npm run dist:mac
```

macOS installers can only be built on macOS. If you do not have a Mac, run the
"Build installers" workflow from the Actions tab and download the artifact.

## Features

- Sign-in per user, before any agent runs
- Streaming chat with markdown and code blocks
- Tool call cards with diffs
- Permission prompts showing the actual diff before you approve
- Token and cost usage per session
- Activity heatmap of your own work
- Plugins, skills and MCP servers, managed from Settings
- Session restore, search, rename, export
- Attached dev server preview
- Model picker and permission modes
- File mentions, image paste, drag and drop

## How it works

```
React renderer  <--IPC-->  Electron main  --spawn-->  grok agent stdio
                                                      JSON-RPC (ACP)
```

The main process owns the child process and the ACP client. Preload exposes a
typed `window.gronk` API with context isolation on. The renderer has no Node
access.

Your data lives in the app's `userData` directory as `gronk-store.json`, and can
be relocated from Settings.

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- Credentials stay in the Grok CLI (`~/.grok/auth.json` or `XAI_API_KEY`).
  Gronk never stores or forwards tokens.
- Tools run with your user's permissions. Treat "Bypass all" as YOLO.
- Every IPC handler validates its sender and arguments.

## Contributing

```bash
npm run verify   # typecheck and tests
npm test         # tests only
npm run test:live # contract tests against your real Grok CLI, opt-in
```

Tests must pass on all three platforms in CI.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

You may use, modify and ship Gronk commercially, including in closed source
products. The licence does not grant rights to the Gronk name or logo, so a fork
is free to exist but not to call itself Gronk.

**The Grok CLI is not part of Gronk and is not redistributed here.** Gronk
launches whichever binary you installed yourself. You obtain and use that CLI
under xAI's terms, with your own account.

Gronk is an independent project, not affiliated with or endorsed by xAI. "Grok"
is a trademark of xAI, used here only to describe what this app connects to.

Bundled packages are credited in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Electron and Chromium ship
their own notices inside the packaged app.
