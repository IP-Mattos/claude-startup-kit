# Claude Startup Kit — installer
# Idempotent: safe to run multiple times. Won't duplicate hooks or markdown blocks.
#
# What it does:
#   1. Verifies dependencies (gentle-ai, code, python, claude code)
#   2. Copies scripts to ~/.claude/scripts/
#   3. Restores UTF-8 BOM on startup-brief.ps1 (required for Unicode)
#   4. Merges SessionStart hooks into ~/.claude/settings.json
#   5. Appends user-custom blocks to ~/.claude/CLAUDE.md (only if missing)
#   6. Copies the launcher .bat to Windows Startup folder
#
# Run from the repo root:  .\install.ps1

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$scriptsDst = Join-Path $claudeDir "scripts"
$startupFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"

function Write-Info($msg)  { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[err ] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=== Claude Startup Kit installer ===" -ForegroundColor Magenta
Write-Host ""

# ---------- 1. Dependency check ----------
Write-Info "Checking dependencies..."
$missing = @()

if (-not (Get-Command gentle-ai -ErrorAction SilentlyContinue)) {
    $missing += "gentle-ai (install: irm https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.ps1 | iex)"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    $missing += "python (install Python 3 and add to PATH)"
}
if (-not (Get-Command code.cmd -ErrorAction SilentlyContinue)) {
    $missing += "VS Code (the 'code' CLI must be on PATH)"
}
if (-not (Test-Path $claudeDir)) {
    $missing += "Claude Code (~/.claude/ not found — install Claude Code first)"
}

if ($missing.Count -gt 0) {
    Write-Err "Missing dependencies:"
    $missing | ForEach-Object { Write-Host "       - $_" -ForegroundColor Yellow }
    Write-Err "Install them and re-run."
    exit 1
}
Write-Ok "All dependencies present."

# ---------- 2. Copy scripts ----------
Write-Info "Copying scripts to $scriptsDst ..."
if (-not (Test-Path $scriptsDst)) {
    New-Item -ItemType Directory -Path $scriptsDst -Force | Out-Null
}

$scriptFiles = @(
    "check-gentle-ai.sh",
    "daily-brief.sh",
    "startup-brief.ps1",
    "startup-brief-launcher.bat"
)
foreach ($f in $scriptFiles) {
    Copy-Item -Path (Join-Path $repoRoot "scripts\$f") -Destination (Join-Path $scriptsDst $f) -Force
}
Write-Ok "Scripts copied."

# ---------- 3. Restore UTF-8 BOM on startup-brief.ps1 ----------
$psPath = Join-Path $scriptsDst "startup-brief.ps1"
$bytes = [System.IO.File]::ReadAllBytes($psPath)
if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    $bom = [byte[]](0xEF, 0xBB, 0xBF)
    $combined = New-Object byte[] ($bom.Length + $bytes.Length)
    [System.Buffer]::BlockCopy($bom, 0, $combined, 0, $bom.Length)
    [System.Buffer]::BlockCopy($bytes, 0, $combined, $bom.Length, $bytes.Length)
    [System.IO.File]::WriteAllBytes($psPath, $combined)
    Write-Ok "UTF-8 BOM added to startup-brief.ps1"
} else {
    Write-Ok "UTF-8 BOM already present on startup-brief.ps1"
}

# ---------- 4. Merge SessionStart hooks into settings.json ----------
$settingsPath = Join-Path $claudeDir "settings.json"
$bashUserHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
$hookCheck   = "bash $bashUserHome/.claude/scripts/check-gentle-ai.sh"
$hookBrief   = "bash $bashUserHome/.claude/scripts/daily-brief.sh"

if (Test-Path $settingsPath) {
    $settingsRaw = Get-Content $settingsPath -Raw
    $settings = $settingsRaw | ConvertFrom-Json
} else {
    $settings = [PSCustomObject]@{}
}

# Make sure hooks.SessionStart structure exists
if (-not $settings.PSObject.Properties.Name -contains "hooks") {
    $settings | Add-Member -NotePropertyName "hooks" -NotePropertyValue ([PSCustomObject]@{})
}
if (-not $settings.hooks.PSObject.Properties.Name -contains "SessionStart") {
    $settings.hooks | Add-Member -NotePropertyName "SessionStart" -NotePropertyValue @()
}

# Find existing inner-hooks list (we keep things in [0].hooks)
$slot = $null
foreach ($entry in $settings.hooks.SessionStart) {
    if ($entry.PSObject.Properties.Name -contains "hooks") {
        $slot = $entry
        break
    }
}
if (-not $slot) {
    $slot = [PSCustomObject]@{ hooks = @() }
    $settings.hooks.SessionStart = @($settings.hooks.SessionStart) + $slot
}
if (-not $slot.hooks) { $slot.hooks = @() }

$existingCommands = @($slot.hooks | ForEach-Object { $_.command })

if ($existingCommands -notcontains $hookCheck) {
    $slot.hooks = @($slot.hooks) + ([PSCustomObject]@{ type = "command"; command = $hookCheck; timeout = 180 })
    Write-Ok "Added gentle-ai check hook"
} else {
    Write-Ok "gentle-ai check hook already present"
}
if ($existingCommands -notcontains $hookBrief) {
    $slot.hooks = @($slot.hooks) + ([PSCustomObject]@{ type = "command"; command = $hookBrief; timeout = 30 })
    Write-Ok "Added daily-brief hook"
} else {
    Write-Ok "daily-brief hook already present"
}

$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding utf8
Write-Ok "settings.json updated"

# ---------- 5. Append user-custom blocks to CLAUDE.md ----------
$claudeMdPath = Join-Path $claudeDir "CLAUDE.md"
$snippetPath = Join-Path $repoRoot "claude-templates\claude-md-snippets.md"
$snippetsRaw = Get-Content $snippetPath -Raw

# Extract each block by its <!-- user-custom:NAME --> ... <!-- /user-custom:NAME --> marker
$blockRegex = '(?s)(<!-- user-custom:([\w-]+) -->.*?<!-- /user-custom:\2 -->)'
$blockMatches = [regex]::Matches($snippetsRaw, $blockRegex)

$claudeMdRaw = ""
if (Test-Path $claudeMdPath) {
    $claudeMdRaw = Get-Content $claudeMdPath -Raw
}

$appended = $false
foreach ($m in $blockMatches) {
    $block = $m.Groups[1].Value
    $name  = $m.Groups[2].Value
    $marker = "<!-- user-custom:$name -->"
    if ($claudeMdRaw -notlike "*$marker*") {
        if (-not $claudeMdRaw.EndsWith("`n")) { $claudeMdRaw += "`n" }
        $claudeMdRaw += "`n" + $block + "`n"
        Write-Ok "Appended user-custom:$name to CLAUDE.md"
        $appended = $true
    } else {
        Write-Ok "user-custom:$name already in CLAUDE.md"
    }
}
if ($appended) {
    Set-Content -Path $claudeMdPath -Value $claudeMdRaw -Encoding utf8
}

# ---------- 6. Install Startup folder shortcut ----------
$startupBat = Join-Path $startupFolder "claude-daily-brief.bat"
Copy-Item -Path (Join-Path $scriptsDst "startup-brief-launcher.bat") -Destination $startupBat -Force
Write-Ok "Installed launcher in Startup folder: $startupBat"

# ---------- Done ----------
Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Magenta
Write-Host ""
Write-Host "What you have now:" -ForegroundColor Cyan
Write-Host "  - Daily gentle-ai auto-update (runs once per 24h on Claude Code SessionStart)"
Write-Host "  - Daily Brief in Claude Code (first session of the day shows project menu)"
Write-Host "  - Startup brief on PC boot (cmd window with project picker)"
Write-Host ""
Write-Host "Reboot to see the startup brief in action, or run it manually:" -ForegroundColor Cyan
Write-Host "  cmd /c `"$startupBat`""
Write-Host ""
