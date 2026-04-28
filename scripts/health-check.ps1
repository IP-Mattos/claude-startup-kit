# Claude Startup Kit — health check.
# Validates that the install is intact and prints a colored status table.
# Run anytime: powershell -File ~\.claude\scripts\health-check.ps1

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$claudeDir = Join-Path $env:USERPROFILE ".claude"
$scriptsDir = Join-Path $claudeDir "scripts"
$logsDir = Join-Path $claudeDir "logs"
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"

$ESC = [char]27
function C($code, $text) { return "$ESC[${code}m$text$ESC[0m" }
$OK   = C "38;5;42"  "OK  "
$WARN = C "38;5;220" "WARN"
$ERR  = C "38;5;203" "ERR "
$DIM  = "38;5;245"

$checks = @()

function Add-Check {
    param([string]$Name, [string]$Status, [string]$Detail = "")
    $script:checks += [PSCustomObject]@{ Name = $Name; Status = $Status; Detail = $Detail }
}

# 1. Dependencies
foreach ($cmd in @("gentle-ai", "code.cmd", "git", "engram", "gh")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Add-Check "dep: $cmd" $OK
    } else {
        $opt = $cmd -in @("git", "gh")
        Add-Check "dep: $cmd" ($(if ($opt) { $WARN } else { $ERR })) ("not found in PATH" + $(if ($opt) { " (optional)" } else { "" }))
    }
}

# 2. Scripts present
$expected = @(
    "scripts\check-gentle-ai.sh",
    "scripts\daily-brief.sh",
    "scripts\startup-brief.ps1",
    "scripts\startup-brief-launcher.bat",
    "scripts\lib\config.ps1",
    "scripts\lib\logging.ps1",
    "scripts\lib\scan-projects.ps1",
    "scripts\lib\engram.ps1",
    "scripts\lib\themes.ps1",
    "scripts\lib\git-recent.ps1",
    "scripts\lib\github-prs.ps1",
    "scripts\lib\self-update.ps1"
)
foreach ($rel in $expected) {
    $full = Join-Path $claudeDir $rel
    if (Test-Path $full) { Add-Check "file: $rel" $OK }
    else                 { Add-Check "file: $rel" $ERR "missing" }
}

# 3. UTF-8 BOM on .ps1 — only check files installed by the kit (whitelist).
# Other .ps1 files in scripts/ may be the user's own POCs; not the kit's concern.
$kitPsFiles = @(
    "startup-brief.ps1", "health-check.ps1", "standup.ps1",
    "lib\config.ps1", "lib\logging.ps1", "lib\scan-projects.ps1", "lib\engram.ps1",
    "lib\themes.ps1", "lib\git-recent.ps1", "lib\github-prs.ps1",
    "lib\self-update.ps1", "lib\screen-adapt.ps1", "lib\render-layout.ps1"
)
foreach ($rel in $kitPsFiles) {
    $full = Join-Path $scriptsDir $rel
    if (-not (Test-Path $full)) { continue }   # the "missing file" check (#2) already flagged it
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $name = Split-Path $rel -Leaf
    if ($hasBom) { Add-Check ("BOM: " + $name) $OK }
    else         { Add-Check ("BOM: " + $name) $WARN "no UTF-8 BOM (Unicode chars may render incorrectly)" }
}

# 4. settings.json hooks
$settingsPath = Join-Path $claudeDir "settings.json"
if (-not (Test-Path $settingsPath)) {
    Add-Check "settings.json" $ERR "not found"
} else {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $bashUserHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
        $needed = @("bash $bashUserHome/.claude/scripts/check-gentle-ai.sh",
                    "bash $bashUserHome/.claude/scripts/daily-brief.sh")
        $allCommands = @()
        if ($settings.hooks -and $settings.hooks.SessionStart) {
            foreach ($entry in $settings.hooks.SessionStart) {
                if ($entry.hooks) { $allCommands += @($entry.hooks | ForEach-Object { $_.command }) }
            }
        }
        foreach ($n in $needed) {
            $short = ($n -split '/')[-1]
            if ($allCommands -contains $n) { Add-Check "hook: $short" $OK }
            else                            { Add-Check "hook: $short" $ERR "not in settings.json" }
        }
    } catch {
        Add-Check "settings.json" $ERR "invalid JSON: $($_.Exception.Message)"
    }
}

# 5. CLAUDE.md custom blocks
$claudeMd = Join-Path $claudeDir "CLAUDE.md"
if (Test-Path $claudeMd) {
    $raw = Get-Content $claudeMd -Raw
    foreach ($name in @("design-skill-disambiguation", "daily-brief")) {
        if ($raw -like "*<!-- user-custom:$name -->*") { Add-Check "CLAUDE.md: $name" $OK }
        else                                            { Add-Check "CLAUDE.md: $name" $WARN "block missing" }
    }
} else {
    Add-Check "CLAUDE.md" $WARN "not found"
}

# 6. Startup folder shortcut
$startupBat = Join-Path $startupDir "claude-daily-brief.bat"
if (Test-Path $startupBat) { Add-Check "Startup launcher" $OK }
else                       { Add-Check "Startup launcher" $WARN "not installed (won't auto-run on boot)" }

# 7. Logs freshness
$logFile = Join-Path $logsDir "startup-kit.log"
if (Test-Path $logFile) {
    $age = (Get-Date) - (Get-Item $logFile).LastWriteTime
    $hours = [math]::Floor($age.TotalHours)
    if ($hours -le 48) { Add-Check "log activity" $OK "last write ${hours}h ago" }
    else               { Add-Check "log activity" $WARN "stale, last write ${hours}h ago" }
} else {
    Add-Check "log activity" $WARN "no log file (scripts haven't logged yet)"
}

# 8. Version match
$installedVersionFile = Join-Path $scriptsDir ".kit-version"
if (Test-Path $installedVersionFile) {
    $v = (Get-Content $installedVersionFile -Raw).Trim()
    Add-Check "kit version" $OK "v$v installed"
} else {
    Add-Check "kit version" $WARN "no version marker (older install?)"
}

# Render
Write-Host ""
Write-Host "  $(C $DIM '=== Claude Startup Kit — Health Check ===')"
Write-Host ""
$errCount = 0
$warnCount = 0
foreach ($c in $checks) {
    Write-Host ("  [{0}] {1,-32} {2}" -f $c.Status, $c.Name, (C $DIM $c.Detail))
    if ($c.Status -like "*ERR*")  { $errCount++ }
    if ($c.Status -like "*WARN*") { $warnCount++ }
}
Write-Host ""
if ($errCount -eq 0 -and $warnCount -eq 0) {
    Write-Host "  $(C '38;5;42' '✓ All checks passed.')"
} else {
    Write-Host ("  $(C '38;5;245' 'Summary:') {0} errors, {1} warnings" -f $errCount, $warnCount)
    if ($errCount -gt 0) {
        Write-Host "  $(C '38;5;203' 'Re-run install.ps1 from the kit repo to fix missing files.')"
    }
}
Write-Host ""
