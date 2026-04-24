# Claude Startup Kit — installer
#
# Idempotent. Safe to run multiple times. Won't duplicate hooks or markdown blocks.
#
# Usage:
#   .\install.ps1            # install
#   .\install.ps1 -DryRun    # show what would change without touching anything
#   .\install.ps1 -Force     # overwrite user config with shipped defaults

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$scriptsDst = Join-Path $claudeDir "scripts"
$libDst = Join-Path $scriptsDst "lib"
$logsDir = Join-Path $claudeDir "logs"
$startupFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"

function Write-Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[err ] $msg" -ForegroundColor Red }
function Write-Plan($msg) { Write-Host "[plan] $msg" -ForegroundColor Magenta }

$prefix = if ($DryRun) { "[DRY-RUN] " } else { "" }

Write-Host ""
Write-Host "=== Claude Startup Kit installer $prefix===" -ForegroundColor Magenta
Write-Host ""

# ---------- Read kit version ----------
$kitVersion = "unknown"
$versionFile = Join-Path $repoRoot "VERSION"
if (Test-Path $versionFile) {
    $kitVersion = (Get-Content $versionFile -Raw).Trim()
}
Write-Info "Kit version: $kitVersion"

# Check installed version
$installedVersionFile = Join-Path $scriptsDst ".kit-version"
$installedVersion = $null
if (Test-Path $installedVersionFile) {
    $installedVersion = (Get-Content $installedVersionFile -Raw).Trim()
    Write-Info "Currently installed: $installedVersion"
    if ($installedVersion -eq $kitVersion -and -not $Force) {
        Write-Ok "Already up to date. Use -Force to reinstall."
    }
}

# ---------- 1. Dependency check ----------
Write-Info "Checking dependencies..."
$missing = @()

if (-not (Get-Command gentle-ai -ErrorAction SilentlyContinue)) {
    $missing += "gentle-ai (install: irm https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.ps1 | iex)"
}
if (-not (Get-Command code.cmd -ErrorAction SilentlyContinue)) {
    $missing += "VS Code (the 'code.cmd' wrapper must be on PATH)"
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

# ---------- Backup current state (skip in dry-run) ----------
$backupRoot = Join-Path $claudeDir "backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRoot "startup-kit-$stamp"

if (-not $DryRun) {
    if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($f in @("settings.json", "CLAUDE.md")) {
        $src = Join-Path $claudeDir $f
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $backupDir $f) -Force
        }
    }
    Write-Ok "Backup created at: $backupDir"
} else {
    Write-Plan "Would back up settings.json + CLAUDE.md to $backupDir"
}

# ---------- 2. Copy scripts ----------
function Copy-FileSafe {
    param([string]$Src, [string]$Dst, [switch]$Overwrite)
    $name = Split-Path $Dst -Leaf
    if ($DryRun) {
        if (Test-Path $Dst) {
            Write-Plan "Would update: $Dst"
        } else {
            Write-Plan "Would create: $Dst"
        }
        return
    }
    $dstDir = Split-Path $Dst -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    if ((Test-Path $Dst) -and -not $Overwrite -and -not $Force) {
        # Default: overwrite (these scripts are kit-managed)
    }
    Copy-Item -Path $Src -Destination $Dst -Force
    Write-Ok "Copied: $name"
}

Write-Info "Copying scripts..."
$scriptFiles = @("check-gentle-ai.sh", "daily-brief.sh", "startup-brief.ps1", "startup-brief-launcher.bat")
foreach ($f in $scriptFiles) {
    Copy-FileSafe -Src (Join-Path $repoRoot "scripts\$f") -Dst (Join-Path $scriptsDst $f)
}

# Copy lib/
$libFiles = @("config.ps1", "logging.ps1", "scan-projects.ps1", "engram.ps1")
foreach ($f in $libFiles) {
    Copy-FileSafe -Src (Join-Path $repoRoot "scripts\lib\$f") -Dst (Join-Path $libDst $f)
}

# Copy default config (only if user config doesn't exist OR Force)
$userConfigPath = Join-Path $scriptsDst "startup-kit-config.json"
$defaultConfigPath = Join-Path $repoRoot "claude-templates\default-config.json"
if (-not (Test-Path $userConfigPath) -or $Force) {
    Copy-FileSafe -Src $defaultConfigPath -Dst $userConfigPath
    if (-not $DryRun) { Write-Ok "Wrote default config (use -Force to overwrite an existing one)" }
} else {
    Write-Ok "Preserved existing user config: $userConfigPath"
}

# Logs dir
if (-not (Test-Path $logsDir) -and -not $DryRun) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    Write-Ok "Created logs directory: $logsDir"
}

# ---------- 3. UTF-8 BOM on .ps1 files ----------
function Ensure-Bom {
    param([string]$Path)
    if (-not (Test-Path $Path) -or $DryRun) { return }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
        $bom = [byte[]](0xEF, 0xBB, 0xBF)
        $combined = New-Object byte[] ($bom.Length + $bytes.Length)
        [System.Buffer]::BlockCopy($bom, 0, $combined, 0, $bom.Length)
        [System.Buffer]::BlockCopy($bytes, 0, $combined, $bom.Length, $bytes.Length)
        [System.IO.File]::WriteAllBytes($Path, $combined)
    }
}
foreach ($f in @("startup-brief.ps1") + ($libFiles | ForEach-Object { "lib\$_" })) {
    Ensure-Bom (Join-Path $scriptsDst $f)
}
if (-not $DryRun) { Write-Ok "UTF-8 BOM ensured on .ps1 files" }

# ---------- 4. Merge SessionStart hooks into settings.json ----------
$settingsPath = Join-Path $claudeDir "settings.json"
$bashUserHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
$hookCheck = "bash $bashUserHome/.claude/scripts/check-gentle-ai.sh"
$hookBrief = "bash $bashUserHome/.claude/scripts/daily-brief.sh"

if (Test-Path $settingsPath) {
    try {
        $settingsRaw = Get-Content $settingsPath -Raw
        $settings = $settingsRaw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Err "Existing settings.json has invalid JSON: $($_.Exception.Message)"
        Write-Err "Aborting before making changes. Backup is at $backupDir"
        exit 2
    }
} else {
    $settings = [PSCustomObject]@{}
}

if (-not ($settings.PSObject.Properties.Name -contains "hooks")) {
    $settings | Add-Member -NotePropertyName "hooks" -NotePropertyValue ([PSCustomObject]@{})
}
if (-not ($settings.hooks.PSObject.Properties.Name -contains "SessionStart")) {
    $settings.hooks | Add-Member -NotePropertyName "SessionStart" -NotePropertyValue @()
}

$slot = $null
foreach ($entry in $settings.hooks.SessionStart) {
    if ($entry.PSObject.Properties.Name -contains "hooks") { $slot = $entry; break }
}
if (-not $slot) {
    $slot = [PSCustomObject]@{ hooks = @() }
    $settings.hooks.SessionStart = @($settings.hooks.SessionStart) + $slot
}
if (-not $slot.hooks) { $slot.hooks = @() }
$existingCommands = @($slot.hooks | ForEach-Object { $_.command })

if ($existingCommands -notcontains $hookCheck) {
    if ($DryRun) {
        Write-Plan "Would add hook: $hookCheck"
    } else {
        $slot.hooks = @($slot.hooks) + ([PSCustomObject]@{ type = "command"; command = $hookCheck; timeout = 180 })
        Write-Ok "Added gentle-ai check hook"
    }
} else {
    Write-Ok "gentle-ai check hook already present"
}
if ($existingCommands -notcontains $hookBrief) {
    if ($DryRun) {
        Write-Plan "Would add hook: $hookBrief"
    } else {
        $slot.hooks = @($slot.hooks) + ([PSCustomObject]@{ type = "command"; command = $hookBrief; timeout = 30 })
        Write-Ok "Added daily-brief hook"
    }
} else {
    Write-Ok "daily-brief hook already present"
}

if (-not $DryRun) {
    $newJson = $settings | ConvertTo-Json -Depth 20
    # Validate the JSON we're about to write parses cleanly
    try {
        $null = $newJson | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Err "Generated settings.json is invalid — aborting write. Backup at $backupDir"
        exit 3
    }
    $newJson | Set-Content -Path $settingsPath -Encoding utf8
    Write-Ok "settings.json written (validated)"
}

# ---------- 5. Append user-custom blocks to CLAUDE.md ----------
$claudeMdPath = Join-Path $claudeDir "CLAUDE.md"
$snippetPath = Join-Path $repoRoot "claude-templates\claude-md-snippets.md"
$snippetsRaw = Get-Content $snippetPath -Raw

$blockRegex = '(?s)(<!-- user-custom:([\w-]+) -->.*?<!-- /user-custom:\2 -->)'
$blockMatches = [regex]::Matches($snippetsRaw, $blockRegex)

$claudeMdRaw = ""
if (Test-Path $claudeMdPath) { $claudeMdRaw = Get-Content $claudeMdPath -Raw }

$appended = $false
foreach ($m in $blockMatches) {
    $block = $m.Groups[1].Value
    $name  = $m.Groups[2].Value
    $marker = "<!-- user-custom:$name -->"
    if ($claudeMdRaw -notlike "*$marker*") {
        if ($DryRun) {
            Write-Plan "Would append user-custom:$name to CLAUDE.md"
        } else {
            if (-not $claudeMdRaw.EndsWith("`n")) { $claudeMdRaw += "`n" }
            $claudeMdRaw += "`n" + $block + "`n"
            Write-Ok "Appended user-custom:$name"
            $appended = $true
        }
    } else {
        Write-Ok "user-custom:$name already in CLAUDE.md"
    }
}
if ($appended -and -not $DryRun) {
    Set-Content -Path $claudeMdPath -Value $claudeMdRaw -Encoding utf8
}

# ---------- 6. Install Startup folder shortcut ----------
$startupBat = Join-Path $startupFolder "claude-daily-brief.bat"
if ($DryRun) {
    Write-Plan "Would install: $startupBat"
} else {
    Copy-Item -Path (Join-Path $scriptsDst "startup-brief-launcher.bat") -Destination $startupBat -Force
    Write-Ok "Installed launcher in Startup folder: $startupBat"
}

# ---------- 7. Write installed version marker ----------
if (-not $DryRun) {
    Set-Content -Path $installedVersionFile -Value $kitVersion -Encoding ascii -NoNewline
    Write-Ok "Marked installed version: $kitVersion"
}

# ---------- Done ----------
Write-Host ""
if ($DryRun) {
    Write-Host "=== Dry-run complete (no changes made) ===" -ForegroundColor Magenta
    Write-Host "Re-run without -DryRun to apply." -ForegroundColor Cyan
} else {
    Write-Host "=== Installation complete ===" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "What you have now:" -ForegroundColor Cyan
    Write-Host "  - Daily gentle-ai auto-update (runs once per 24h on Claude Code SessionStart)"
    Write-Host "  - Daily Brief in Claude Code (first session of the day shows project menu)"
    Write-Host "  - Startup launcher on PC boot (cmd window with project picker, real Engram summaries)"
    Write-Host ""
    Write-Host "Customize via: $userConfigPath" -ForegroundColor Cyan
    Write-Host "Logs:          $logsDir\startup-kit.log" -ForegroundColor Cyan
    Write-Host ""
}
