<#
.SYNOPSIS
Install the canvas-agent overlay onto a deepseek-harness checkout.

.DESCRIPTION
This overlay is a second-development layer on top of deepseek-harness
v0.1.0-rc.5. The script:

  1. copies the three new canvas packages into the DSH workspace,
  2. overlays the patched upstream files (patches/ mirrors repository paths),
  3. reinstalls workspace links,
  4. rebuilds host types, client bundles, and the web frontend.

The DSH checkout is modified in place. To revert, restore the overlaid files
from the upstream checkout (e.g. git checkout) and remove the three canvas
packages.

.PARAMETER DshPath
Path to the deepseek-harness checkout (must contain pnpm-workspace.yaml).
When omitted, the current directory is tried first; if it is not a DSH
checkout, the script asks interactively.

.EXAMPLE
.\install.ps1 -DshPath C:\work\deepseek-harness

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1   # simplest: asks for the DSH path
#>
param(
  [string]$DshPath = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$release = Split-Path -Parent $MyInvocation.MyCommand.Path

$ws = Join-Path $DshPath 'pnpm-workspace.yaml'
if (-not (Test-Path $ws)) {
  Write-Host ""
  Write-Host "The current directory is not a deepseek-harness checkout: $DshPath"
  Write-Host "Type the full path of your deepseek-harness folder (the one containing pnpm-workspace.yaml),"
  Write-Host "then press Enter. Example: C:\work\deepseek-harness"
  Write-Host ""
  $DshPath = Read-Host "DSH path"
  $DshPath = $DshPath.Trim().Trim('"')
  $ws = Join-Path $DshPath 'pnpm-workspace.yaml'
  if (-not (Test-Path $ws)) {
    throw "not a deepseek-harness checkout: $DshPath (missing pnpm-workspace.yaml)"
  }
}

# Version guard: the overlay targets v0.1.0-rc.5. Warn on a different version
# (the patches may not apply cleanly), but do not hard-fail.
$pkgJson = Join-Path $DshPath 'package.json'
if (Test-Path $pkgJson) {
  $version = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version
  if ($version -ne '0.1.0-rc.5') {
    Write-Warning "DSH version is '$version'; this overlay was built against v0.1.0-rc.5 and may not apply cleanly."
  }
}

Write-Host "Installing canvas-agent overlay onto $DshPath"

# 1. New packages (source only; build outputs are produced locally).
$newPackages = @(
  "$release\packages\canvas\canvas-projection",
  "$release\packages\canvas\tool-canvas-reference",
  "$release\packages\client\ui-canvas"
)
foreach ($pkg in $newPackages) {
  $rel = $pkg.Substring($release.Length + 1)
  $dest = Join-Path $DshPath $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  robocopy $pkg $dest /E /XD node_modules lib dist /NFL /NDL /NJH /NJS | Out-Null
  Write-Host "  + $rel"
}

# 2. Patched upstream files (paths mirror the DSH repository layout).
$patches = Join-Path $release 'patches'
Get-ChildItem $patches -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($patches.Length + 1)
  $dest = Join-Path $DshPath $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Copy-Item $_.FullName $dest -Force
  Write-Host "  ~ $rel"
}

# 3. Install and build.
Push-Location $DshPath
try {
  Write-Host "Installing workspace links..."
  & pnpm install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (is pnpm installed and on PATH?)" }

  Write-Host "Building host libs (Remote types)..."
  & npm run build:lib:host
  if ($LASTEXITCODE -ne 0) { throw "build:lib:host failed" }

  Write-Host "Bundling client plugins..."
  # The api-remotes client bundle embeds the canvasTrees Remote method table
  # (typert-generated from canvas-projection's @Remote methods); without a
  # fresh bundle the browser's remote.canvasTrees misses later-added methods
  # (e.g. adoptWorkflow) and confirm-adopt throws "not a function".
  & pnpm --filter @deepseek-ai/dsh-api-remotes bundle
  # The sessions service grew openRail (the canvas rail's fork view — open a
  # conversation window without switching the workspace selection); its client
  # bundle must carry the method or the canvas fork-to-rail throws.
& pnpm --filter @deepseek-ai/dsh-client-ui-canvas bundle
  & pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle
  & pnpm --filter @deepseek-ai/dsh-client-ui-model-selection bundle

  Write-Host "Building web frontend..."
  & pnpm --filter @deepseek-ai/dsh-web-frontend run build
  if ($LASTEXITCODE -ne 0) { throw "web frontend build failed" }
}
catch {
  Write-Host ""
  Write-Host "Installation failed at: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Common causes:"
  Write-Host "  - DSH version differs from v0.1.0-rc.5 (see the warning above)"
  Write-Host "  - pnpm/node not on PATH, or a registry/network issue during pnpm install"
  Write-Host "  - the DSH checkout was already modified by another overlay"
  Write-Host "Re-run after fixing the cause; overlaid files are idempotent (re-copying is safe)."
  exit 1
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "=================================================="
Write-Host " Done. Your DSH is now the canvas deployment."
Write-Host "=================================================="
Write-Host ""
Write-Host "Start it with:"
Write-Host "  cd $DshPath"
Write-Host "  pnpm dsh web --port 3090"
Write-Host ""
Write-Host "Then open http://127.0.0.1:3090 in your browser."
Write-Host ""
Write-Host "Verify: the left workspace list opens a session, the main tab is"
Write-Host "  画布 (canvas), and the right rail hosts the full composer."
Write-Host ""
Write-Host "To revert later: git checkout the files under patches/ in your DSH"
Write-Host "checkout and delete packages\canvas\* and packages\client\ui-canvas."
