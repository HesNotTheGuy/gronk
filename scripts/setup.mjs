/**
 * Installs dependencies without letting any package's install script run, checks
 * what landed, then fetches the Electron binary.
 *
 * That last step is why this exists. `npm ci --ignore-scripts` is the safe way to
 * install, but Electron's binary is downloaded BY its postinstall script, so
 * disabling scripts leaves node_modules/electron without an executable and
 * `npm run dev` fails. This runs Electron's own installer explicitly, and
 * nothing else's.
 *
 * Replaces a PowerShell script that was invoked with `-ExecutionPolicy Bypass`.
 * That is how malware runs PowerShell, it only worked on Windows, and it asked
 * strangers to trust code they had not read before they could install.
 *
 * Zero dependencies, runs anywhere node does.
 *
 *   node scripts/setup.mjs [--offline]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')

function run(command, args, label) {
  console.log(`\n=== ${label} ===`)
  console.log(`$ ${command} ${args.join(' ')}\n`)
  // shell:true on Windows so `npm` resolves to npm.cmd. Every argument here is a
  // literal from this file — nothing user-supplied reaches the shell.
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

const hasLockfile = existsSync(path.join(ROOT, 'package-lock.json'))

// `ci` over `install`: it installs exactly what the lockfile pins and refuses if
// package.json disagrees. `install` is free to resolve something newer, which is
// the opposite of what a security-motivated install should do.
const installArgs = hasLockfile
  ? ['ci', '--ignore-scripts', '--no-fund', '--no-audit']
  : ['install', '--ignore-scripts', '--no-fund', '--no-audit']

if (!hasLockfile) {
  console.log('No package-lock.json found; falling back to `npm install`.')
}

const installStatus = run('npm', installArgs, 'Install with lifecycle scripts disabled')
if (installStatus !== 0) {
  console.error('\nInstall failed.')
  process.exit(installStatus)
}

const scanArgs = ['./scripts/security-check.mjs']
if (OFFLINE) scanArgs.push('--offline')
const scanStatus = run(process.execPath, scanArgs, 'Scan what was installed')
if (scanStatus !== 0) {
  console.error('\nScan failed. Do not build or run this tree.')
  console.error('Remove node_modules and package-lock.json, then investigate before retrying.')
  process.exit(scanStatus)
}

// Only Electron's installer, and only after the scan passed. This is the one
// install script we deliberately allow, because it fetches the official Electron
// binary from Electron's own release host.
const electronInstaller = path.join(ROOT, 'node_modules', 'electron', 'install.js')
if (existsSync(electronInstaller)) {
  const status = run(process.execPath, [electronInstaller], 'Fetch the Electron binary')
  if (status !== 0) {
    console.error('\nElectron binary download failed. `npm run dev` will not start until it succeeds.')
    process.exit(status)
  }
} else {
  console.log('\nnode_modules/electron/install.js not found; skipping the binary step.')
}

console.log('\nDone. Next: npm run verify, then npm run dev')
