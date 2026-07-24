# Grocky

Desktop GUI for the [Grok Build CLI](https://x.ai) — a Claude Code–style chat app that talks to Grok over **ACP** (`grok agent stdio`).

Works on **Windows, macOS, and Linux**. The app spawns your local `grok` binary and talks to it over ACP.

**Your account only:** Grocky never ships with a login and never stores API keys or tokens in the app. When someone runs the app, they must sign in with **their own** Grok account via the official CLI (`grok login`). Credentials live only on that machine under that OS user (`~/.grok/auth.json` or optional `XAI_API_KEY`). Your sign-in here does not appear in anyone else’s install.

### Surfaces

| Surface | Purpose |
|---------|---------|
| **Home** | Hub — jump into Chat or Projects |
| **Chat** | General Grok conversation (like the website / X), CLI-backed |
| **Projects** | Coding agent in a folder — tools, permissions, sessions |

Chat is **not** an Electron wrap of grok.com. It uses the same `grok agent` ACP path with a conversational system prompt and a local sandbox cwd under app `userData` (so it never pollutes your real project list).

## Features

- **Per-user sign-in** (browser OAuth / device code) before agent use
- Open a project folder and start a Grok agent session
- Streaming chat with markdown rendering (code copy buttons)
- Live **tool call** cards with kind labels + **diff** preview for edits
- **Permission** prompts (allow once / always / deny) + local audit log
- Recent projects + session search / rename / delete / export
- Session restore (ACP + local transcript cache)
- Model picker (`grok models`)
- Composer: **@ file mentions**, image paste, attach files, drag-drop
- Live **plan** checklist panel when the agent emits plan updates
- Theme (dark / light / system), custom Grok binary path, health check
- Optional **always approve** tools (`--always-approve`, gated)
- Cross-platform binary discovery (`~/.grok/bin/grok`, PATH, Homebrew)
- Shortcuts: `Ctrl/Cmd+O` open · `Ctrl/Cmd+N` new session · `Ctrl/Cmd+,` settings

## Prerequisites

1. **Node.js 20+**
2. **Grok Build CLI** installed  
   - Windows: `irm https://x.ai/cli/install.ps1 | iex`  
   - macOS/Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
3. **Your own Grok account** — sign in from the Grocky sign-in screen (browser OAuth or device code), or run `grok login` in a terminal. Optional advanced: set `XAI_API_KEY` in the environment (never paste keys into the app; Grocky will not save them).

### Auth model (important)

| Rule | Why |
|------|-----|
| No credentials in the repo or packaged app | Your login is not embedded for other people |
| Sign-in required before agent start | Each install must verify its own account |
| Tokens stay in the Grok CLI, not Grocky | `~/.grok/auth.json` / env — never `grocky-store.json` |
| Tokens never sent to the renderer | UI only sees safe status (`Signed in`, `grok.com`, …) |
| Sign out = `grok logout` + stop agent | Clears credentials on **this** machine only |
| Scope = this OS user on this computer | Someone else on another PC (or another Windows user) is signed out until they log in |

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

- Full project file tree side panel
- Embedded terminal (ACP fs/terminal client capabilities)
- Permission modes beyond YOLO (`acceptEdits`, plan mode)
- WebSocket mode (`grok agent serve`) for multi-window
- Desktop notifications when the agent finishes
- Auto-update packaging

## License

MIT
