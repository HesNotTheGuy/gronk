# Supply-chain security (npm)

Grocky intentionally keeps a **small, well-known dependency set** and installs
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

```powershell
# From repo root — preferred
.\scripts\safe-npm-install.ps1
```

That script:

1. Checks **declared package names** against
   [DataDog’s malicious npm dataset](https://github.com/DataDog/malicious-software-packages-dataset)
2. Runs `npm install --ignore-scripts` (no code execution from packages)
3. Scans `package-lock.json` + `node_modules` for high-risk scopes and worm files
4. Only then runs **Electron’s** binary downloader (`node_modules/electron/install.js`)

Scan only (no install):

```powershell
.\scripts\check-deps-security.ps1
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
4. Run `.\scripts\check-deps-security.ps1` after install
5. Never use `-AllowScripts` unless you have read the install script

## If you already ran a dirty install

Assume secrets on the machine may be burned:

1. Delete `node_modules` and the lockfile
2. Rotate npm tokens, cloud keys, SSH keys, and GitHub PATs used on that box
3. Search GitHub for unexpected public repos / branches named like `Shai-Hulud`
4. Reinstall only via `.\scripts\safe-npm-install.ps1`

## Agent / AI policy for this repo

Any automated assistant working in this repo should:

- **Not** run bare `npm install` without the safe script (or equivalent checks)
- **Not** add dependencies without a malware-name check
- Prefer removing deps over adding new ones when possible

## Runtime safety (Grocky app)

- **Bypass permissions (YOLO)** requires an explicit confirmation modal and
  `alwaysApproveAck` in the local store before `--always-approve` is passed.
- A persistent red banner shows while bypass is active.
- Permission decisions are written to a local **audit log** in Electron
  `userData` (`grocky-store.json` → `permissionAudit`).
- Optional client FS methods are **path-jailed** to the open project root.
- Prefer not advertising client `fs` / `terminal` capabilities unless handlers
  exist (claiming them without responses freezes ACP turns).
- Do **not** add npm packages for Phase features when the Grok CLI already
  exposes the capability (`grok models`, ACP `session/load`, etc.).
