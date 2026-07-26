#Requires -Version 5.1
<#
.SYNOPSIS
  Pre- and post-install supply-chain checks for Gronk (Shai-Hulud era).

.DESCRIPTION
  1. Ensures none of our declared package names appear in Datadog's malicious
     npm dataset (when available online or via local cache).
  2. After node_modules exists, scans for known Shai-Hulud / worm indicators:
     - setup_bun.js, bun_environment.js
     - .github/workflows/*shai-hulud*
  3. Lists packages that declare install lifecycle scripts (review before enabling).

  Exit codes:
    0 = no findings
    1 = hard fail (malicious package name or critical indicator)
    2 = warnings only (lifecycle scripts present - review recommended)
#>

param(
  [switch]$SkipOnlineDataset,
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
Set-Location $ProjectRoot

$pkgPath = Join-Path $ProjectRoot 'package.json'
if (-not (Test-Path $pkgPath)) {
  Write-Error "package.json not found at $pkgPath"
}

$pkg = Get-Content -Raw $pkgPath | ConvertFrom-Json
$declared = @()
foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
  $block = $pkg.$section
  if ($null -eq $block) { continue }
  $block.PSObject.Properties | ForEach-Object { $declared += $_.Name }
}
$declared = $declared | Sort-Object -Unique

Write-Host '== Gronk dependency security check ==' -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"
Write-Host "Declared packages: $($declared.Count)"
Write-Host ''

# Known high-risk scopes (historical Shai-Hulud / Mini waves)
$riskyScopes = @(
  '@ctrl/',
  '@tanstack/',
  '@bitwarden/',
  '@antv/',
  '@redhat-cloud-services/',
  '@ensdomains/',
  '@crowdstrike/',
  '@asyncapi/'
)

$hardFail = $false
$warn = $false

$cacheDir = Join-Path $ProjectRoot '.cache'
$datasetPath = Join-Path $cacheDir 'datadog-malicious-npm-manifest.json'
# FIX-21: fail closed unless explicitly skipped
if (-not $SkipOnlineDataset) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $url = 'https://raw.githubusercontent.com/DataDog/malicious-software-packages-dataset/main/samples/npm/manifest.json'
  try {
    Write-Host 'Fetching Datadog malicious npm manifest...' -ForegroundColor DarkGray
    Invoke-WebRequest -Uri $url -OutFile $datasetPath -UseBasicParsing -TimeoutSec 60
  } catch {
    Write-Host "FAIL: could not refresh malware dataset: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Pass -SkipOnlineDataset only if you intentionally accept offline install risk.' -ForegroundColor Red
    $hardFail = $true
  }
}

# Enumerate ALL resolved package names from lockfile (not just top-level package.json)
$lockPath = Join-Path $ProjectRoot 'package-lock.json'
$allNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($n in $declared) { [void]$allNames.Add($n) }
if (Test-Path $lockPath) {
  try {
    $lockObj = Get-Content -Raw $lockPath | ConvertFrom-Json
    if ($lockObj.packages) {
      foreach ($prop in $lockObj.packages.PSObject.Properties) {
        $key = [string]$prop.Name
        if ([string]::IsNullOrWhiteSpace($key)) { continue }
        # keys like "node_modules/foo" or "node_modules/@scope/pkg"
        $name = $key -replace '^node_modules/', ''
        if ($name -match 'node_modules/') {
          $parts = $name -split 'node_modules/'
          $name = $parts[-1]
        }
        if (-not [string]::IsNullOrWhiteSpace($name)) {
          [void]$allNames.Add($name)
        }
      }
    }
  } catch {
    Write-Host "WARN: could not fully parse package-lock packages map: $($_.Exception.Message)" -ForegroundColor Yellow
    $warn = $true
  }
}

if (Test-Path $datasetPath) {
  Write-Host "Checking $($allNames.Count) resolved names against malware dataset..."
  try {
    $manifest = Get-Content -Raw $datasetPath | ConvertFrom-Json
  } catch {
    Write-Host "FAIL: malware dataset unreadable/corrupt: $($_.Exception.Message)" -ForegroundColor Red
    $hardFail = $true
    $manifest = $null
  }
  if ($null -ne $manifest) {
    foreach ($name in $allNames) {
      $prop = $manifest.PSObject.Properties[$name]
      if ($null -ne $prop -and $null -ne $prop.Value) {
        Write-Host "FAIL: $name is listed as malicious (versions: $($prop.Value -join ', '))" -ForegroundColor Red
        $hardFail = $true
      }
    }
    if (-not $hardFail) {
      Write-Host 'OK: no resolved package names in malware dataset' -ForegroundColor Green
    }
  }
} elseif (-not $SkipOnlineDataset) {
  Write-Host 'FAIL: no malware dataset on disk and online fetch required' -ForegroundColor Red
  $hardFail = $true
} else {
  Write-Host 'WARN: dataset skipped by -SkipOnlineDataset' -ForegroundColor Yellow
  $warn = $true
}

if (Test-Path $lockPath) {
  Write-Host ''
  Write-Host 'Scanning package-lock.json for high-risk scopes...'
  $lockText = Get-Content -Raw $lockPath
  foreach ($scope in $riskyScopes) {
    if ($lockText -match [regex]::Escape($scope)) {
      $pattern = [regex]::Escape('node_modules/' + $scope.TrimEnd('/')) + '/[^"]+'
      $found = [regex]::Matches($lockText, $pattern)
      $sample = ($found | Select-Object -First 5 | ForEach-Object { $_.Value }) -join ', '
      Write-Host "FAIL: lockfile references risky scope $scope ($sample)" -ForegroundColor Red
      $hardFail = $true
    }
  }
  if (-not $hardFail) {
    Write-Host 'OK: no known high-risk scopes in lockfile' -ForegroundColor Green
  }
}

$nm = Join-Path $ProjectRoot 'node_modules'
if (Test-Path $nm) {
  Write-Host ''
  Write-Host 'Scanning node_modules for worm indicators...'

  $indicatorNames = @(
    'setup_bun.js',
    'bun_environment.js',
    'shai-hulud-workflow.yml'
  )

  foreach ($ind in $indicatorNames) {
    $hits = Get-ChildItem -Path $nm -Recurse -Filter $ind -ErrorAction SilentlyContinue |
      Select-Object -First 10 FullName
    foreach ($h in $hits) {
      Write-Host "FAIL: indicator file: $($h.FullName)" -ForegroundColor Red
      $hardFail = $true
    }
  }

  $wf = Get-ChildItem -Path $nm -Recurse -Filter '*shai-hulud*' -ErrorAction SilentlyContinue |
    Select-Object -First 20 FullName
  foreach ($h in $wf) {
    Write-Host "FAIL: shai-hulud path: $($h.FullName)" -ForegroundColor Red
    $hardFail = $true
  }

  if (-not $hardFail) {
    Write-Host 'OK: no classic worm indicator files found' -ForegroundColor Green
  }

  Write-Host ''
  Write-Host 'Packages declaring install lifecycle scripts (review):'
  $scriptPkgs = @()
  Get-ChildItem -Path $nm -Recurse -Filter package.json -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $j = Get-Content -Raw $_.FullName | ConvertFrom-Json
      $scripts = $j.scripts
      if ($null -eq $scripts) { return }
      $hooks = @()
      foreach ($h in @('preinstall', 'install', 'postinstall', 'preuninstall', 'postuninstall')) {
        if ($scripts.$h) { $hooks += "$h=$($scripts.$h)" }
      }
      if ($hooks.Count -gt 0) {
        $rel = $_.FullName.Substring($nm.Length + 1)
        $scriptPkgs += [pscustomobject]@{ Package = $rel; Hooks = ($hooks -join '; ') }
      }
    } catch { }
  }

  if ($scriptPkgs.Count -eq 0) {
    Write-Host '  (none found)' -ForegroundColor DarkGray
  } else {
    $warn = $true
    $scriptPkgs |
      Sort-Object Package |
      Select-Object -First 40 |
      ForEach-Object { Write-Host ('  - {0}: {1}' -f $_.Package, $_.Hooks) -ForegroundColor Yellow }
    if ($scriptPkgs.Count -gt 40) {
      Write-Host "  ... and $($scriptPkgs.Count - 40) more" -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host 'NOTE: lifecycle scripts were listed for review. Prefer install with --ignore-scripts,' -ForegroundColor Yellow
    Write-Host '      then enable only required ones (e.g. electron binary download).' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  Write-Host 'node_modules not present yet - post-install indicator scan skipped.' -ForegroundColor DarkGray
}

Write-Host ''
if ($hardFail) {
  Write-Host 'RESULT: FAIL - do not enable scripts or run the app until cleaned.' -ForegroundColor Red
  exit 1
}
if ($warn) {
  Write-Host 'RESULT: WARN - no malware names/indicators, but review lifecycle scripts.' -ForegroundColor Yellow
  exit 2
}
Write-Host 'RESULT: PASS' -ForegroundColor Green
exit 0
