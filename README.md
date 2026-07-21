# Grocky

Desktop GUI for the [Grok Build CLI](https://x.ai) — a Claude Code–style chat app that talks to Grok over **ACP** (`grok agent stdio`).

Works on **Windows, macOS, and Linux**. The app spawns your local `grok` binary; no separate API key plumbing is required if you already use the CLI.

## Features (MVP)

- Open a project folder and start a Grok agent session
- Streaming chat with markdown rendering
- Live **tool call** cards (expand for input/output)
- **Permission** prompts (allow once / always / deny)
- Recent projects + local session history
- Optional **always approve** tools (`--always-approve`)
- Cross-platform binary discovery (`~/.grok/bin/grok`, PATH, Homebrew paths on macOS)

## Prerequisites

1. **Node.js 20+**
2. **Grok Build CLI** installed and authenticated  
   - Windows: `irm https://x.ai/cli/install.ps1 | iex`  
   - macOS/Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`  
   - Then: `grok login` (or set `XAI_API_KEY`)

## Develop

**Do not run bare `npm install` as the first step.** npm supply-chain worms
(Shai-Hulud and variants) often run in package lifecycle scripts. Use the
safe installer (scripts disabled → malware scan → Electron binary only):

```powershell
# Preferred (Windows)
.\scripts\safe-npm-install.ps1
# or
npm run safe-install

npm run dev
```

Details: [SECURITY.md](./SECURITY.md). Scan without installing:

```powershell
.\scripts\check-deps-security.ps1
```

## Build / package

```bash
npm run build

# Platform installers (run on that OS for native signing/notarization)
npm run dist:win
npm run dist:mac    # needs a Mac for a real .dmg test
npm run dist:linux
```

macOS builds can be produced on a Mac (or CI with macOS runners). Code is written with portable paths and Electron APIs so it should run once packaged; we can’t fully QA macOS from Windows alone.

## Architecture

```
┌─────────────────────┐     IPC      ┌──────────────────────┐
│  React renderer     │◄────────────►│  Electron main       │
│  chat / tools / UI  │              │  AgentManager        │
└─────────────────────┘              └──────────┬───────────┘
                                                │ spawn
                                                ▼
                                     ┌──────────────────────┐
                                     │  grok agent stdio    │
                                     │  JSON-RPC (ACP)      │
                                     └──────────────────────┘
```

- **Main process** owns the child process and ACP JSON-RPC client
- **Preload** exposes a typed `window.grocky` API (context isolation on)
- **Renderer** is a pure React UI — no Node access

## Settings store

User data lives under Electron `userData` as `grocky-store.json` (recent projects, settings, session list).

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`
- Tool execution still runs with your user permissions via the Grok agent — treat **Always approve** like `--yolo`
- Prefer reviewing permission prompts for shell/network tools

## Roadmap ideas

- Resume sessions via full ACP `session/load` history hydrate
- Diff viewer / file tree side panel
- Embedded terminal
- Model picker from `grok models`
- Theme picker + custom Grok binary path UI
- WebSocket mode (`grok agent serve`) for multi-window

## License

MIT
