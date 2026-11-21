# ==============================================================================
# OpenCode Auto-Build Script
# Builds CLI, Desktop, and Windows Installer in one click
# ==============================================================================

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " 🚀 Building OpenCode Custom Edition" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# Step 1: Build CLI
Write-Host "`n[1/3] Building CLI..." -ForegroundColor Yellow
Set-Location "$Root\packages\cli"
bun run script/build.ts --single --skip-web-ui --skip-install

# Step 2: Build Desktop UI
Write-Host "`n[2/3] Building Desktop App..." -ForegroundColor Yellow
Set-Location "$Root\packages\desktop"
bun run script/build.ts

# Step 3: Package Electron Installer
Write-Host "`n[3/3] Packaging Windows Installer (.exe)..." -ForegroundColor Yellow
bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts

$InstallerSrc = "$Root\packages\desktop\dist\opencode-desktop-win-x64.exe"
if (Test-Path $InstallerSrc) {
  $OutDir = "$Root\release"
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $FinalExe = "$OutDir\OpenCode-Setup.exe"
  Copy-Item $InstallerSrc $FinalExe -Force

  Write-Host "`n=========================================" -ForegroundColor Green
  Write-Host " 🎉 BUILD SUCCESSFUL!" -ForegroundColor Green
  Write-Host " Installer: $FinalExe" -ForegroundColor Green
  Write-Host " Size: $([math]::Round((Get-Item $FinalExe).Length/1MB, 1)) MB" -ForegroundColor Green
  Write-Host "=========================================" -ForegroundColor Green
} else {
  Write-Host "`n❌ Installer build failed: $InstallerSrc not found" -ForegroundColor Red
}

Set-Location $Root
