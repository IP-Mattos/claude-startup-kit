# Claude Startup Kit — security/integrity audit.
# Walks ~/.claude looking for things you didn't put there or settings that
# look risky. NOT an antivirus — it can't detect unknown malware. What it
# CAN do is flag drift from a known-good baseline so you can spot anything
# weird quickly.
#
# Usage:
#   ~\.claude\scripts\claude-audit.ps1            # human-readable table
#   ~\.claude\scripts\claude-audit.ps1 -Json      # JSON for piping

[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$NoNetwork,   # skip TCP connection check (slow on some systems)
    [switch]$Summary      # only print/return counts; cheap mode used by the brief
)

# Summary mode short-circuits: skips network, runs the cheap checks, writes a
# state file the brief reads to decide whether to flash an alert banner.
if ($Summary) { $NoNetwork = $true }

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$claudeDir  = Join-Path $env:USERPROFILE ".claude"
$scriptsDir = Join-Path $claudeDir "scripts"
$logsDir    = Join-Path $claudeDir "logs"
$findings   = New-Object System.Collections.Generic.List[PSObject]

function Add-Finding {
    param(
        [Parameter(Mandatory=$true)][ValidateSet("OK", "INFO", "WARN", "CRIT")][string]$Level,
        [Parameter(Mandatory=$true)][string]$Category,
        [Parameter(Mandatory=$true)][string]$Title,
        [string]$Detail = ""
    )
    $findings.Add([PSCustomObject]@{
        Level    = $Level
        Category = $Category
        Title    = $Title
        Detail   = $Detail
    })
}

# ============================================================
# 1. PROCESSES — long-running / orphan processes
# ============================================================
$watchedNames = @('Code', 'gentle-ai', 'engram', 'powershell', 'pwsh', 'cmd', 'claude')
$now = Get-Date
foreach ($pname in $watchedNames) {
    $procs = Get-Process -Name $pname -ErrorAction SilentlyContinue
    if (-not $procs) { continue }
    foreach ($p in $procs) {
        try {
            $start = $p.StartTime
            $runtime = $now - $start
            $h = [int]$runtime.TotalHours
            if ($h -gt 48) {
                Add-Finding "WARN" "PROCESSES" ("{0} (PID {1}) running for {2}h" -f $pname, $p.Id, $h) "Long-running. If you don't recognize it, consider killing it."
            } elseif ($h -gt 12) {
                Add-Finding "INFO" "PROCESSES" ("{0} (PID {1}) running for {2}h" -f $pname, $p.Id, $h)
            }
        } catch {
            # Some system processes deny StartTime access — skip silently
        }
    }
}

# ============================================================
# 2. HOOKS — settings.json hooks should only be the kit's
# ============================================================
$settingsPath = Join-Path $claudeDir "settings.json"
$settings = $null
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Add-Finding "CRIT" "HOOKS" "settings.json invalid JSON" $_.Exception.Message
    }
}

if ($settings) {
    $bashHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
    $expectedHooks = @(
        "bash $bashHome/.claude/scripts/check-gentle-ai.sh",
        "bash $bashHome/.claude/scripts/daily-brief.sh"
    )
    $allHooks = @()
    if ($settings.hooks) {
        foreach ($evt in $settings.hooks.PSObject.Properties) {
            foreach ($entry in $evt.Value) {
                if ($entry.hooks) {
                    foreach ($h in $entry.hooks) {
                        $allHooks += [PSCustomObject]@{
                            Event   = $evt.Name
                            Type    = $h.type
                            Command = $h.command
                            Timeout = $h.timeout
                        }
                    }
                }
            }
        }
    }
    Add-Finding "INFO" "HOOKS" ("{0} hook(s) registered" -f $allHooks.Count)
    foreach ($h in $allHooks) {
        if ($h.Command -notin $expectedHooks) {
            Add-Finding "WARN" "HOOKS" "Non-kit hook on $($h.Event)" $h.Command
        }
    }
}

# ============================================================
# 3. PERMISSIONS — flag dangerous patterns in allow rules
# ============================================================
if ($settings -and $settings.permissions) {
    $dangerPatterns = @(
        @{ Pattern = 'rm\s+-rf';        Note = "destructive recursive delete" },
        @{ Pattern = '\bsudo\b';         Note = "elevated privileges" },
        @{ Pattern = 'curl.*\|\s*bash'; Note = "remote script execution" },
        @{ Pattern = 'iex\b';            Note = "PowerShell remote-exec idiom (Invoke-Expression)" },
        @{ Pattern = 'Invoke-Expression';Note = "PowerShell exec from string" },
        @{ Pattern = '\.\.\\?\.\.';      Note = "path traversal" }
    )
    foreach ($rule in @($settings.permissions.allow)) {
        foreach ($dp in $dangerPatterns) {
            if ($rule -match $dp.Pattern) {
                Add-Finding "CRIT" "PERMISSIONS" "Allow rule matches risky pattern: $($dp.Note)" $rule
            }
        }
    }
    Add-Finding "INFO" "PERMISSIONS" ("defaultMode: {0}" -f $settings.permissions.defaultMode)
}

# ============================================================
# 4. SCRIPTS — files in ~/.claude/scripts/ that the kit didn't install
# ============================================================
$kitWhitelist = @(
    "check-gentle-ai.sh", "daily-brief.sh",
    "startup-brief.ps1", "startup-brief-launcher.bat",
    "health-check.ps1", "standup.ps1", "claude-audit.ps1", "cleanup.ps1",
    "brief.cmd", "claude-brief-hotkey.ahk",
    "startup-kit-config.json",
    ".gentle-ai-last-check", ".daily-brief-last-date", ".gentle-ai-last-seen-version", ".kit-version",
    "lib"
)
$libWhitelist = @(
    "config.ps1", "logging.ps1", "scan-projects.ps1", "engram.ps1",
    "themes.ps1", "git-recent.ps1", "github-prs.ps1", "self-update.ps1",
    "screen-adapt.ps1", "render-layout.ps1"
)
if (Test-Path $scriptsDir) {
    $rootEntries = Get-ChildItem -Path $scriptsDir -Force -ErrorAction SilentlyContinue
    foreach ($e in $rootEntries) {
        if ($kitWhitelist -notcontains $e.Name) {
            Add-Finding "INFO" "SCRIPTS" "Non-kit file in ~/.claude/scripts/: $($e.Name)" "Created outside the kit. Review if you don't recognize it."
        }
    }
    $libDirPath = Join-Path $scriptsDir "lib"
    if (Test-Path $libDirPath) {
        foreach ($e in (Get-ChildItem -Path $libDirPath -File -ErrorAction SilentlyContinue)) {
            if ($libWhitelist -notcontains $e.Name) {
                Add-Finding "WARN" "SCRIPTS" "Non-kit file in lib/: $($e.Name)" "lib/ should only contain kit modules. Review."
            }
        }
    }
}

# ============================================================
# 5. PLUGINS — list enabled plugins
# ============================================================
if ($settings) {
    if ($settings.enabledPlugins) {
        $count = @($settings.enabledPlugins.PSObject.Properties).Count
        Add-Finding "INFO" "PLUGINS" "$count plugin(s) enabled"
        foreach ($pl in $settings.enabledPlugins.PSObject.Properties) {
            Add-Finding "INFO" "PLUGINS" "  - $($pl.Name): $($pl.Value)"
        }
    }
    if ($settings.extraKnownMarketplaces) {
        foreach ($mp in $settings.extraKnownMarketplaces.PSObject.Properties) {
            $src = $mp.Value.source
            $detail = "type=$($src.source)"
            if ($src.repo) { $detail += " repo=$($src.repo)" }
            Add-Finding "INFO" "PLUGINS" "Marketplace: $($mp.Name)" $detail
        }
    }
}

# ============================================================
# 6. LOGS — recent ERROR / WARN entries
# ============================================================
$logFile = Join-Path $logsDir "startup-kit.log"
if (Test-Path $logFile) {
    $tail = Get-Content $logFile -Tail 200 -ErrorAction SilentlyContinue
    $errors = @($tail | Where-Object { $_ -match '\[ERROR\]' })
    $warns  = @($tail | Where-Object { $_ -match '\[WARN\]' })
    if ($errors.Count -gt 0) {
        Add-Finding "WARN" "LOGS" "$($errors.Count) ERROR entries in last 200 log lines"
        foreach ($e in $errors | Select-Object -Last 3) { Add-Finding "INFO" "LOGS" "  $e" }
    }
    if ($warns.Count -gt 5) {
        Add-Finding "INFO" "LOGS" "$($warns.Count) WARN entries in last 200 log lines (>5)"
    }
} else {
    Add-Finding "INFO" "LOGS" "No log file yet at $logFile"
}

# ============================================================
# 7. DISK — usage of ~/.claude
# ============================================================
function Get-DirSize {
    param($Path)
    if (-not (Test-Path $Path)) { return 0 }
    return (Get-ChildItem -Path $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
}
$totalBytes = Get-DirSize $claudeDir
Add-Finding "INFO" "DISK" ("~/.claude total: {0:N1} MB" -f ($totalBytes / 1MB))
$projectsBytes = Get-DirSize (Join-Path $claudeDir "projects")
Add-Finding "INFO" "DISK" ("  projects/ : {0:N1} MB (Claude Code session logs)" -f ($projectsBytes / 1MB))
$logsBytes = Get-DirSize $logsDir
Add-Finding "INFO" "DISK" ("  logs/     : {0:N1} MB" -f ($logsBytes / 1MB))
$backupsBytes = Get-DirSize (Join-Path $claudeDir "backups")
if ($backupsBytes -gt 0) {
    Add-Finding "INFO" "DISK" ("  backups/  : {0:N1} MB (kit pre-install backups)" -f ($backupsBytes / 1MB))
}
if (($totalBytes / 1MB) -gt 5000) {
    Add-Finding "WARN" "DISK" "~/.claude is over 5 GB" "Consider trimming projects/ or logs/"
}

# ============================================================
# 8. NETWORK — non-localhost connections from Claude processes
# ============================================================
if (-not $NoNetwork) {
    $netCmd = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($netCmd) {
        $watchedPids = @()
        foreach ($pname in $watchedNames) {
            $watchedPids += Get-Process -Name $pname -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }
        }
        foreach ($pid_ in $watchedPids) {
            $conns = Get-NetTCPConnection -OwningProcess $pid_ -State Established -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                if ($c.RemoteAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::')) { continue }
                $proc = (Get-Process -Id $pid_ -ErrorAction SilentlyContinue).Name
                Add-Finding "INFO" "NETWORK" ("{0} (PID {1}) → {2}:{3}" -f $proc, $pid_, $c.RemoteAddress, $c.RemotePort)
            }
        }
    } else {
        Add-Finding "INFO" "NETWORK" "Get-NetTCPConnection not available — skipping"
    }
}

# ============================================================
# 9. SETTINGS DRIFT — settings.local.json present?
# ============================================================
$localSettingsPath = Join-Path $claudeDir "settings.local.json"
if (Test-Path $localSettingsPath) {
    Add-Finding "WARN" "DRIFT" "settings.local.json exists — overrides settings.json" "Inspect: $localSettingsPath"
}

# ============================================================
# 10. ENV VARS — Claude/MCP/Anthropic environment variables
# ============================================================
$envPatterns = @('^CLAUDE_', '^MCP_', '^ANTHROPIC_')
$matched = New-Object System.Collections.Generic.List[string]
foreach ($e in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    foreach ($p in $envPatterns) {
        if ($e.Key -match $p) {
            $matched.Add(("{0} = {1}" -f $e.Key, $(if ($e.Key -match 'KEY|TOKEN|SECRET') { "<redacted>" } else { $e.Value })))
        }
    }
}
if ($matched.Count -gt 0) {
    Add-Finding "INFO" "ENV" ("{0} relevant env var(s)" -f $matched.Count)
    foreach ($m in $matched) { Add-Finding "INFO" "ENV" "  $m" }
}

# ============================================================
# 11. PLUGIN SOURCES — flag plugins whose marketplace isn't declared
# ============================================================
if ($settings -and $settings.enabledPlugins) {
    $declaredMarkets = @()
    if ($settings.extraKnownMarketplaces) {
        $declaredMarkets = @($settings.extraKnownMarketplaces.PSObject.Properties.Name)
    }
    foreach ($pl in $settings.enabledPlugins.PSObject.Properties) {
        # Plugin name format is typically "name@marketplace"
        if ($pl.Name -match '@(.+)$') {
            $market = $matches[1]
            if ($declaredMarkets -notcontains $market) {
                Add-Finding "WARN" "DRIFT" "Plugin '$($pl.Name)' uses marketplace '$market' which isn't declared in extraKnownMarketplaces"
            }
        }
    }
}

# ============================================================
# 12. BIG JSONLs — single Claude session files > 100 MB
# ============================================================
$projectsDir = Join-Path $claudeDir "projects"
if (Test-Path $projectsDir) {
    $bigFiles = Get-ChildItem -Path $projectsDir -Recurse -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Length -gt 100MB }
    foreach ($f in $bigFiles) {
        $sizeMB = [math]::Round($f.Length / 1MB, 1)
        Add-Finding "WARN" "DISK" "Large JSONL: $($f.Name) ($sizeMB MB)" "Consider running cleanup.ps1"
    }
}

# ============================================================
# 13. HOOK TIMEOUTS — flag hooks with > 300s timeout
# ============================================================
if ($settings -and $settings.hooks) {
    foreach ($evt in $settings.hooks.PSObject.Properties) {
        foreach ($entry in $evt.Value) {
            if ($entry.hooks) {
                foreach ($h in $entry.hooks) {
                    if ($h.timeout -and [int]$h.timeout -gt 300) {
                        Add-Finding "WARN" "HOOKS" "Hook timeout > 300s ($($h.timeout)s) on $($evt.Name)" $h.command
                    }
                }
            }
        }
    }
}

# ============================================================
# 14. STARTUP FOLDER — what else runs at Windows login?
# ============================================================
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
if (Test-Path $startupDir) {
    $startupItems = Get-ChildItem -Path $startupDir -File -ErrorAction SilentlyContinue
    Add-Finding "INFO" "STARTUP" "$($startupItems.Count) item(s) in Windows Startup folder"
    foreach ($s in $startupItems) {
        $name = $s.Name
        if ($name -eq "claude-daily-brief.bat") {
            Add-Finding "INFO" "STARTUP" "  - $name (kit launcher)"
        } else {
            Add-Finding "INFO" "STARTUP" "  - $name"
        }
    }
}

# ============================================================
# 9. KIT VERSION
# ============================================================
$kitVerFile = Join-Path $scriptsDir ".kit-version"
if (Test-Path $kitVerFile) {
    $v = (Get-Content $kitVerFile -Raw).Trim()
    Add-Finding "INFO" "KIT" "Installed kit version: v$v"
} else {
    Add-Finding "WARN" "KIT" "No .kit-version marker — kit may not be installed"
}

# ============================================================
# RENDER
# ============================================================
$critCount = @($findings | Where-Object { $_.Level -eq "CRIT" }).Count
$warnCount = @($findings | Where-Object { $_.Level -eq "WARN" }).Count
$infoCount = @($findings | Where-Object { $_.Level -eq "INFO" }).Count

if ($Summary) {
    $state = [PSCustomObject]@{
        Timestamp = (Get-Date).ToString("o")
        Crit      = $critCount
        Warn      = $warnCount
        Info      = $infoCount
        Findings  = @($findings | Where-Object { $_.Level -in @("CRIT", "WARN") } | Select-Object Level, Category, Title)
    }
    $statePath = Join-Path $scriptsDir ".audit-summary.json"
    try {
        $state | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath -Encoding utf8
    } catch {}
    if ($Json) {
        $state | ConvertTo-Json -Depth 5
    } else {
        Write-Host ("audit summary: {0} crit, {1} warn, {2} info" -f $critCount, $warnCount, $infoCount)
    }
    return
}

if ($Json) {
    $findings | ConvertTo-Json -Depth 5
    return
}

$ESC = [char]27
function _color($code, $text) { return "$ESC[${code}m$text$ESC[0m" }
$lvlColor = @{
    "OK"   = "38;5;42"
    "INFO" = "38;5;245"
    "WARN" = "38;5;220"
    "CRIT" = "38;5;203"
}
$crit = $critCount
$warn = $warnCount
$info = $infoCount

Write-Host ""
Write-Host "  $(_color '38;5;245' '────────────────────────────────────────────────────────────────')"
Write-Host "  $(_color '1;38;5;255' 'claude audit')  $(_color '38;5;245' ('·  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')))"
Write-Host "  $(_color '38;5;245' '────────────────────────────────────────────────────────────────')"
Write-Host ""

$lastCategory = ""
foreach ($f in $findings | Sort-Object @{ Expression = {
    switch ($_.Level) {
        "CRIT" { 0 }
        "WARN" { 1 }
        "OK"   { 2 }
        "INFO" { 3 }
        default { 4 }
    }
} }, Category) {
    if ($f.Category -ne $lastCategory) {
        Write-Host ""
        Write-Host "  $(_color '1;38;5;51' $f.Category)"
        $lastCategory = $f.Category
    }
    $colorCode = $lvlColor[$f.Level]
    $tag = "[$($f.Level.PadRight(4))]"
    Write-Host ("    {0}  {1}" -f (_color $colorCode $tag), $f.Title)
    if ($f.Detail) {
        Write-Host ("           {0}" -f (_color '38;5;240' $f.Detail))
    }
}

Write-Host ""
Write-Host "  $(_color '38;5;245' '────────────────────────────────────────────────────────────────')"
# Build the summary line piece by piece — multi-line concatenation with nested
# function calls and hash lookups was tripping the PS parser into thinking the
# concatenated string was a SwitchParameter on some Windows builds.
$critColor = $lvlColor["CRIT"]
$warnColor = $lvlColor["WARN"]
$infoColor = $lvlColor["INFO"]
$grayColor = '38;5;245'
$pCrit = _color $critColor "$crit critical"
$pSep1 = _color $grayColor "  ·  "
$pWarn = _color $warnColor "$warn warnings"
$pSep2 = _color $grayColor "  ·  "
$pInfo = _color $infoColor "$info info"
# Don't name this $summary — that collides with the script's [switch]$Summary param.
$summaryLine = "  Summary: $pCrit$pSep1$pWarn$pSep2$pInfo"
Write-Host $summaryLine
Write-Host ""
if ($crit -gt 0) {
    Write-Host "  $(_color '1;38;5;203' '✗ CRITICAL findings — review settings.json and remove the listed allow rules.')"
} elseif ($warn -gt 0) {
    Write-Host "  $(_color '38;5;220' '⚠ Warnings present — investigate non-kit hooks or long-running processes.')"
} else {
    Write-Host "  $(_color '38;5;42' '✓ Clean.')"
}
Write-Host ""
