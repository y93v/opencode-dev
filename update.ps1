# ==============================================================================
# OpenCode Upstream Update Script
# Fetches upstream releases and rebases your custom features onto the new version
# ==============================================================================

param(
  [string]$TargetVersion = ""
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " 🔄 OpenCode Upstream Update Helper" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Fetch tags from official repo
Write-Host "`n[1/4] Fetching latest tags from official repo..." -ForegroundColor Yellow
git fetch origin --tags

# 2. List the 5 latest release tags
Write-Host "`nRecent official releases:" -ForegroundColor Green
$tags = git tag --sort=-v:refname | Select-Object -First 5
foreach ($t in $tags) {
  Write-Host "  - $t" -ForegroundColor White
}

if (-not $TargetVersion) {
  $TargetVersion = Read-Host "`nEnter target version to update to (e.g. $($tags[0]))"
}

if (-not $TargetVersion) {
  Write-Host "No version selected. Exiting." -ForegroundColor Yellow
  return
}

# 3. Rebase our commits onto the chosen target tag
Write-Host "`n[2/4] Rebasing custom features onto $TargetVersion..." -ForegroundColor Yellow
git rebase --onto $TargetVersion c0ad18b4 main

if ($LASTEXITCODE -ne 0) {
  Write-Host "`n⚠️ Rebase had conflicts! Please resolve conflicts and run 'git rebase --continue'" -ForegroundColor Red
  return
}

# 4. Refresh dependencies
Write-Host "`n[3/4] Installing updated dependencies..." -ForegroundColor Yellow
bun install

Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " 🎉 Successfully updated to $TargetVersion!" -ForegroundColor Green
Write-Host " Run .\build.ps1 to build the new installer." -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
