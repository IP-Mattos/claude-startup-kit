# Build claudewatch from this (canonical) source and install it for the current
# user at ~/claudewatch — so THIS machine runs the same binary the CSK ships.
#
# This is the single source of truth for claudewatch. Workflow when you change it:
#   1. edit the .go files here (and the scripts in ../../src-tauri/resources/claudewatch)
#   2. .\install-local.ps1            # update this machine
#   3. release a new CSK version      # ship it to everyone (the release CI builds
#                                       this same source and bundles it)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:USERPROFILE 'claudewatch'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Stop a running instance first so the .exe isn't locked, then build.
Get-Process claudewatch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
go -C $PSScriptRoot build -ldflags "-s -w" -o (Join-Path $dest 'claudewatch.exe') .

# Copy the launcher scripts + icon from the bundled resources (their source).
$res = Join-Path $PSScriptRoot '..\..\src-tauri\resources\claudewatch'
foreach ($f in 'claude-dash.ps1', 'claude-dash.cmd', 'claudewatch.ico') {
    Copy-Item (Join-Path $res $f) $dest -Force
}

Write-Host "claudewatch installed -> $dest"
