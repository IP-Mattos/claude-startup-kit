# Claude Startup Kit — uninstaller
# Removes everything install.ps1 added. Safe and idempotent.

$ErrorActionPreference = "Stop"
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$scriptsDir = Join-Path $claudeDir "scripts"
$startupFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"

function Write-Info($msg)  { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[warn] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== Claude Startup Kit uninstaller ===" -ForegroundColor Magenta
Write-Host ""

# 1. Remove Startup folder shortcut
$startupBat = Join-Path $startupFolder "claude-daily-brief.bat"
if (Test-Path $startupBat) {
    Remove-Item $startupBat -Force
    Write-Ok "Removed Startup folder launcher"
} else {
    Write-Info "No Startup launcher found"
}

# 2. Remove scripts (only those installed by this kit)
$ourScripts = @(
    "check-gentle-ai.sh",
    "daily-brief.sh",
    "startup-brief.ps1",
    "startup-brief-launcher.bat",
    ".gentle-ai-last-check",
    ".daily-brief-last-date",
    ".gentle-ai-last-seen-version"
)
foreach ($f in $ourScripts) {
    $p = Join-Path $scriptsDir $f
    if (Test-Path $p) {
        Remove-Item $p -Force
        Write-Ok "Removed $f"
    }
}

# 3. Strip our hooks from settings.json
$settingsPath = Join-Path $claudeDir "settings.json"
$bashUserHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
$ourHooks = @(
    "bash $bashUserHome/.claude/scripts/check-gentle-ai.sh",
    "bash $bashUserHome/.claude/scripts/daily-brief.sh"
)

if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($settings.hooks -and $settings.hooks.SessionStart) {
        foreach ($entry in $settings.hooks.SessionStart) {
            if ($entry.hooks) {
                $entry.hooks = @($entry.hooks | Where-Object { $ourHooks -notcontains $_.command })
            }
        }
        # Drop empty entries
        $settings.hooks.SessionStart = @($settings.hooks.SessionStart | Where-Object { $_.hooks.Count -gt 0 })
        $settings | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding utf8
        Write-Ok "Stripped our hooks from settings.json"
    }
}

# 4. Strip our user-custom blocks from CLAUDE.md
$claudeMdPath = Join-Path $claudeDir "CLAUDE.md"
if (Test-Path $claudeMdPath) {
    $raw = Get-Content $claudeMdPath -Raw
    $blocks = @("design-skill-disambiguation", "daily-brief")
    $changed = $false
    foreach ($name in $blocks) {
        $pattern = "(?s)\s*<!-- user-custom:$name -->.*?<!-- /user-custom:$name -->\s*"
        if ([regex]::IsMatch($raw, $pattern)) {
            $raw = [regex]::Replace($raw, $pattern, "`n")
            $changed = $true
            Write-Ok "Removed user-custom:$name from CLAUDE.md"
        }
    }
    if ($changed) {
        Set-Content -Path $claudeMdPath -Value $raw -Encoding utf8
    }
}

Write-Host ""
Write-Host "=== Uninstall complete ===" -ForegroundColor Magenta
Write-Host ""
