# Supply-chain security (npm)

Gronk intentionally keeps a **small, well-known dependency set** and installs
with a **scripts-disabled-first** workflow because of ongoing npm worms
(Shai-Hulud / Mini Shai-Hulud and copycats through 2025–2026).

## Threat model (short)

These attacks often:

1. Compromise a popular package or maintainer account
2. Ship a new version with a **malicious `preinstall` / `postinstall`**
3. Steal tokens, cloud keys, and npm publish rights
4. Re-publish under every package the victim can access (worm)

PyPI has seen related cross-ecosystem campaigns; treat **any** package install
the same way: **verify before executing install scripts**.

## How we install here

```bash
# From repo root — preferred
npm run setup
```

That script:

1. Runs `npm ci --ignore-scripts`, which installs exactly what `package-lock.json`
   pins and executes no lifecycle scripts from any package. `ci` rather than
   `install`, because `install` is free to resolve something newer than the
   lockfile, which is the opposite of what a security-motivated install should do.
2. Scans the **resolved versions** in `package-lock.json` against
   [DataDog’s malicious npm dataset](https://github.com/DataDog/malicious-software-packages-dataset),
   and flags packages in scopes that have been compromised before. Version-aware,
   not name-only: a name match alone would flag `debug` and `chalk` forever, since
   both have a poisoned release in their history and a safe one today.
3. Aborts on any hit, before step 4 can run.
4. Only then runs **Electron’s** binary downloader
   (`node_modules/electron/install.js`) — the single install script deliberately
   allowed, because it fetches the official binary from Electron's own release host.

The scan runs after the install rather than before it, because the thing worth
checking is the resolved dependency graph, and that does not exist until the
lockfile has been walked. Nothing from a package has executed at that point.

Scan only (no install):

```bash
npm run security-check
```

## What is NOT on our allowlist

We deliberately avoid scopes heavily hit by past waves, including examples like:

- `@ctrl/*` (original tinycolor wave)
- `@tanstack/*` (Mini Shai-Hulud wave)
- `@antv/*`, `@bitwarden/cli` fakes, `@redhat-cloud-services/*`, etc.

If a future feature needs a new dependency, **name-check it first** and prefer
packages with long history, multiple maintainers, and no surprising install scripts.

## Before adding a new package

1. `npm view <name> name version maintainers time.created time.modified`
2. Confirm maintainers look legitimate (not a brand-new account on a famous name)
3. Prefer **exact versions** in `package.json` for anything security-sensitive
4. Run `npm run security-check` after install
5. Never re-run an install with lifecycle scripts enabled to "make it work"
   without reading what those scripts do

## If you already ran a dirty install

Assume secrets on the machine may be burned:

1. Delete `node_modules` and the lockfile
2. Rotate npm tokens, cloud keys, SSH keys, and GitHub PATs used on that box
3. Search GitHub for unexpected public repos / branches named like `Shai-Hulud`
4. Reinstall only via `npm run setup`

## Runtime safety (Gronk app)

### Per-install authentication (no shared login)

- Gronk **does not ship credentials**. Your sign-in on one machine never
  travels with the git repo, the installer, or another person’s copy of the app.
- Every install must authenticate with **its own** Grok account before the
  agent can start (browser OAuth or device code via the official CLI).
- Login: `grok login --oauth` or `grok login --device-auth`. Sign-out:
  `grok logout` + stop any running agent.
- **Never** store API keys or OAuth tokens in `gronk-store.json` or send them
  over IPC to the renderer. The UI only receives a safe `AuthStatus` snapshot
  (authenticated yes/no, method, non-secret label).
- Optional CI-style auth: process environment `XAI_API_KEY` is detected as a
  boolean presence flag only — the key value is never read into the UI.
- Credentials live under the OS user’s Grok home (`~/.grok/auth.json` by
  default). That path is local to that user account on that computer.
- Agent start is gated in both IPC (`gronk:start-agent`) and
  `AgentManager.bootAgent` via `assertAuthenticated()`.

### Local data (transcripts / audit)

- Session transcripts and the permission audit log live in Electron `userData`
  (`gronk-store.json`) **on this machine only**.
- **Your own conversation is stored verbatim.** Message text and agent thoughts
  are written exactly as they appear, with no redaction. That is deliberate: it
  is your text, on your machine, and silently altering it would corrupt the
  transcript you came back for.
- Redaction applies to the machine-generated payloads around it — tool call
  content and raw input, and the permission audit log — where obvious secret
  patterns (API keys, JWTs, `api_key=…`, emails) are stripped before write.
- The practical consequence: if you paste a secret into a message, it is on disk
  in plaintext. Treat the store as a sensitive local cache and do not copy it
  into tickets or chat.
- Optional future hardening: encrypt at rest with Electron `safeStorage`.

### Tool permissions

- **Bypass permissions (YOLO)** requires an explicit confirmation modal and
  `alwaysApproveAck` in the local store before `--always-approve` is passed.
- A persistent red banner shows while bypass is active.
- Permission decisions are written to a local **audit log** in Electron
  `userData` (`gronk-store.json` → `permissionAudit`).
- Optional client FS methods are **path-jailed** to the open project root.
- Prefer not advertising client `fs` / `terminal` capabilities unless handlers
  exist (claiming them without responses freezes ACP turns).
- Do **not** add npm packages for Phase features when the Grok CLI already
  exposes the capability (`grok models`, ACP `session/load`, etc.).
