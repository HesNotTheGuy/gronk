#Requires -Version 5.1
<#
.SYNOPSIS
  Safer npm install for Gronk against Shai-Hulud-style supply-chain malware.

.DESCRIPTION
  Default flow (defense in depth):
    1. Pre-check declared package names vs Datadog malicious dataset
    2. npm install --ignore-scripts  (no postinstall code execution)
    3. Re-scan node_modules + lockfile for indicators / risky scopes
    4. Only if clean: run Electron's install script (needs network for binary)

  Will NOT run a full unrestricted npm install unless you pass -AllowScripts
  after a successful scan (not recommended as default).
#>

param(
  [switch]$AllowScripts,
  [switch]$SkipElectronBinary,
  [switch]$SkipOnlineDataset
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$check = Join-Path $PSScriptRoot 'check-deps-security.ps1'

Write-Host '=== Step 1: pre-install package name check ===' -ForegroundColor Cyan
& $check -SkipOnlineDataset:$SkipOnlineDataset
$pre = $LASTEXITCODE
if ($pre -eq 1) {
  Write-Error 'Pre-install security check failed. Aborting install.'
}

Write-Host ''
Write-Host '=== Step 2: npm install --ignore-scripts ===' -ForegroundColor Cyan
Write-Host 'Lifecycle scripts disabled so install-time malware cannot run.' -ForegroundColor DarkGray
npm install --ignore-scripts --no-fund --no-audit
if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install failed (exit $LASTEXITCODE)"
}

Write-Host ''
Write-Host '=== Step 3: post-install scan (lockfile + node_modules) ===' -ForegroundColor Cyan
& $check -SkipOnlineDataset
$post = $LASTEXITCODE
if ($post -eq 1) {
  Write-Host ''
  Write-Host 'HARD FAIL after install. Removing node_modules is recommended:' -ForegroundColor Red
  Write-Host '  Remove-Item -Recurse -Force node_modules; Remove-Item package-lock.json' -ForegroundColor Yellow
  exit 1
}

if ($AllowScripts) {
  Write-Host ''
  Write-Host '=== Step 4: re-running install WITH scripts (-AllowScripts) ===' -ForegroundColor Yellow
  npm install --no-fund --no-audit
  exit $LASTEXITCODE
}

if (-not $SkipElectronBinary) {
  Write-Host ''
  Write-Host '=== Step 4: Electron binary only (required, trusted package) ===' -ForegroundColor Cyan
  $electronInstall = Join-Path $root 'node_modules\electron\install.js'
  if (Test-Path $electronInstall) {
    # Electron's postinstall downloads the official binary; not a random package script.
    node $electronInstall
    if ($LASTEXITCODE -ne 0) {
      Write-Error 'Electron binary install failed'
    }
    Write-Host 'Electron binary install finished.' -ForegroundColor Green
  } else {
    Write-Host 'WARN: electron/install.js not found - is electron in package.json?' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '=== Done (scripts mostly disabled) ===' -ForegroundColor Green
Write-Host 'Next: npm run typecheck   then   npm run dev'
Write-Host 'If a package truly needs its install script, re-run after reviewing it:'
Write-Host '  .\scripts\safe-npm-install.ps1 -AllowScripts'
exit 0
