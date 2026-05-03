# Claude Startup Kit — disk cleanup utility.
#
# Usage:
#   cleanup.ps1                # interactive: shows preview, asks before deleting
#   cleanup.ps1 -DryRun        # show what would be cleaned, change nothing
#   cleanup.ps1 -Yes           # non-interactive, just delete
#   cleanup.ps1 -Logs          # only old log files
#   cleanup.ps1 -Backups       # only kit pre-install backups
#   cleanup.ps1 -Projects      # only old Claude Code project JSONLs
#
# Defaults: anything older than 30 days is fair game. Override with -OlderThanDays.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Logs,
    [switch]$Backups,
    [switch]$Projects,
    [int]$OlderThanDays = 30
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$claudeDir   = Join-Path $env:USERPROFILE ".claude"
$logsDir     = Join-Path $claudeDir "logs"
$backupsDir  = Join-Path $claudeDir "backups"
$projectsDir = Join-Path $claudeDir "projects"
$cutoff      = (Get-Date).AddDays(-$OlderThanDays)

# Colors
$ESC = [char]27
function C($code, $text) { return "$ESC[${code}m$text$ESC[0m" }
$CYAN="38;5;51"; $GREEN="38;5;42"; $YELLOW="38;5;220"; $GRAY="38;5;245"; $RED="38;5;203"; $WHITE="38;5;255"

# If no specific category requested, do all
$doAll = -not ($Logs -or $Backups -or $Projects)
if ($doAll) { $Logs = $true; $Backups = $true; $Projects = $true }

$plan = New-Object System.Collections.Generic.List[PSObject]

function Add-PlanItem {
    param([string]$Category, [string]$Path, [long]$SizeBytes, [datetime]$LastWrite)
    $script:plan.Add([PSCustomObject]@{
        Category  = $Category
        Path      = $Path
        Bytes     = $SizeBytes
        LastWrite = $LastWrite
    })
}

# 1. LOGS — delete log files older than cutoff (but keep startup-kit.log itself)
if ($Logs -and (Test-Path $logsDir)) {
    Get-ChildItem -Path $logsDir -File -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $cutoff -and $_.Name -ne "startup-kit.log"
    } | ForEach-Object {
        Add-PlanItem -Category "logs" -Path $_.FullName -SizeBytes $_.Length -LastWrite $_.LastWriteTime
    }
    # Truncate the active log if it's too big (keep last 1000 lines)
    $activeLog = Join-Path $logsDir "startup-kit.log"
    if (Test-Path $activeLog) {
        $activeSize = (Get-Item $activeLog).Length
        if ($activeSize -gt 5MB) {
            Add-PlanItem -Category "logs (truncate)" -Path $activeLog -SizeBytes ($activeSize - 100KB) -LastWrite (Get-Item $activeLog).LastWriteTime
        }
    }
}

# 2. BACKUPS — kit pre-install backups older than cutoff
if ($Backups -and (Test-Path $backupsDir)) {
    Get-ChildItem -Path $backupsDir -Directory -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $cutoff
    } | ForEach-Object {
        $bytes = (Get-ChildItem -Path $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if (-not $bytes) { $bytes = 0 }
        Add-PlanItem -Category "backups" -Path $_.FullName -SizeBytes $bytes -LastWrite $_.LastWriteTime
    }
}

# 3. PROJECTS — old JSONL files inside ~/.claude/projects/<project>/
if ($Projects -and (Test-Path $projectsDir)) {
    Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem -Path $_.FullName -Filter "*.jsonl" -File -ErrorAction SilentlyContinue | Where-Object {
            $_.LastWriteTime -lt $cutoff
        } | ForEach-Object {
            Add-PlanItem -Category "projects (jsonl)" -Path $_.FullName -SizeBytes $_.Length -LastWrite $_.LastWriteTime
        }
    }
}

# Render plan
$totalBytes = ($plan | Measure-Object -Property Bytes -Sum).Sum
if (-not $totalBytes) { $totalBytes = 0 }

Write-Host ""
Write-Host "  $(C $GRAY '────────────────────────────────────────────────────────────────')"
Write-Host "  $(C "1;$WHITE" 'cleanup')  $(C $GRAY ('·  files older than ' + $OlderThanDays + ' days'))"
Write-Host "  $(C $GRAY '────────────────────────────────────────────────────────────────')"
Write-Host ""

if ($plan.Count -eq 0) {
    Write-Host "  $(C $GREEN '✓ nothing to clean')"
    Write-Host ""
    return
}

# Group by category for display
$byCategory = $plan | Group-Object -Property Category | Sort-Object Name
foreach ($g in $byCategory) {
    $catBytes = ($g.Group | Measure-Object -Property Bytes -Sum).Sum
    if (-not $catBytes) { $catBytes = 0 }
    Write-Host ("  {0}  {1}  {2}" -f
        (C "1;$CYAN" $g.Name),
        (C $GRAY "$($g.Count) item(s)"),
        (C $WHITE ("{0:N1} MB" -f ($catBytes / 1MB))))
    foreach ($item in ($g.Group | Sort-Object LastWrite | Select-Object -First 5)) {
        $name = Split-Path $item.Path -Leaf
        Write-Host ("    {0}  {1}  {2}" -f
            (C $GRAY $item.LastWrite.ToString("yyyy-MM-dd")),
            (C $WHITE ("{0,8:N1} KB" -f ($item.Bytes / 1KB))),
            (C $GRAY $name))
    }
    if ($g.Count -gt 5) {
        Write-Host ("    {0}" -f (C $GRAY "  ... and $($g.Count - 5) more"))
    }
}

Write-Host ""
Write-Host ("  $(C $GRAY 'TOTAL  ·  ')$(C "1;$WHITE" ("{0:N1} MB" -f ($totalBytes / 1MB)))$(C $GRAY ('  in ' + $plan.Count + ' items'))")
Write-Host ""

if ($DryRun) {
    Write-Host "  $(C $YELLOW '⚠ dry-run — nothing deleted')"
    Write-Host "  $(C $GRAY 'rerun without -DryRun to apply')"
    Write-Host ""
    return
}

if (-not $Yes) {
    Write-Host -NoNewline "  $(C $YELLOW 'proceed?') $(C $GRAY '[y/N]') $(C $CYAN '_> ')"
    $answer = Read-Host
    if ($answer -notmatch '^[yY]') {
        Write-Host "  $(C $GRAY 'aborted')"
        Write-Host ""
        return
    }
}

# Apply
$deleted = 0
$freed   = 0
$failed  = 0
foreach ($item in $plan) {
    try {
        if ($item.Category -eq "logs (truncate)") {
            # Keep last 1000 lines
            $lines = Get-Content -Path $item.Path -Tail 1000 -ErrorAction Stop
            Set-Content -Path $item.Path -Value $lines -Encoding utf8
            $newSize = (Get-Item $item.Path).Length
            $freed += ($item.Bytes - ($item.Bytes - $newSize))   # approximate
            $deleted++
        } elseif (Test-Path $item.Path -PathType Container) {
            Remove-Item -Path $item.Path -Recurse -Force -ErrorAction Stop
            $freed += $item.Bytes
            $deleted++
        } else {
            Remove-Item -Path $item.Path -Force -ErrorAction Stop
            $freed += $item.Bytes
            $deleted++
        }
    } catch {
        $failed++
        Write-Host "  $(C $RED ('✗ failed: ' + $item.Path))  $(C $GRAY $_.Exception.Message)"
    }
}

Write-Host ""
Write-Host ("  $(C $GREEN '✓ cleaned')  $(C $WHITE $deleted) $(C $GRAY 'items')  $(C $WHITE ('{0:N1} MB' -f ($freed / 1MB))) $(C $GRAY 'freed')")
if ($failed -gt 0) {
    Write-Host ("  $(C $RED ('✗ ' + $failed + ' failed')) $(C $GRAY '— see messages above')")
}
Write-Host ""
