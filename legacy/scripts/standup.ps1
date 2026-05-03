# Claude Startup Kit — standup generator.
# Pulls recent activity from Engram + git and writes a markdown standup to stdout.
# Pipe to clip:  .\standup.ps1 | Set-Clipboard
#
# Sections:
#   - Yesterday: session_summary Goals from Engram for projects active in last 48h
#   - Plus: latest commit subject per project (when in a git repo)
#   - Today's projects: any project with activity in the last 14d, sorted by recency

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "lib\config.ps1")
. (Join-Path $scriptDir "lib\scan-projects.ps1")
. (Join-Path $scriptDir "lib\engram.ps1")
. (Join-Path $scriptDir "lib\git-recent.ps1")

$cfg = Get-StartupKitConfig -ConfigDir $scriptDir
$projects = @(Get-ClaudeProjects -ActivityWindowDays $cfg.projects.activityWindowDays)

$today = Get-Date -Format "yyyy-MM-dd"
$out = New-Object System.Text.StringBuilder
[void]$out.AppendLine("# Standup — $today")
[void]$out.AppendLine()
[void]$out.AppendLine("## Ayer")

$recent = @($projects | Where-Object { $_.DaysAgo -le $cfg.projects.recentForBriefDays })
if ($recent.Count -eq 0) {
    [void]$out.AppendLine("- (sin actividad reciente registrada)")
} else {
    foreach ($p in $recent) {
        $name = Split-Path $p.Path -Leaf
        $bullet = "**$name**"

        $engramName = Get-EngramProjectName -ProjectPath $p.Path
        $goal = $null
        if ($engramName) { $goal = Get-EngramProjectGoal -ProjectName $engramName -MaxChars 200 }
        if ($goal) { $bullet += " — $goal" }

        [void]$out.AppendLine("- $bullet")

        $commit = Get-RecentCommitInfo -ProjectPath $p.Path
        if ($commit) {
            [void]$out.AppendLine("  - last commit: ``$($commit.Hash)`` $($commit.Subject) _($($commit.Ago), $($commit.Author))_")
        }
    }
}

[void]$out.AppendLine()
[void]$out.AppendLine("## Hoy / proyectos activos (últimos $($cfg.projects.activityWindowDays)d)")

if ($projects.Count -eq 0) {
    [void]$out.AppendLine("- (ninguno)")
} else {
    foreach ($p in $projects) {
        $name = Split-Path $p.Path -Leaf
        $label = if ($p.DaysAgo -eq 0) { "hoy" } elseif ($p.DaysAgo -eq 1) { "ayer" } else { "$($p.DaysAgo)d" }
        [void]$out.AppendLine("- $name _($label)_")
    }
}

Write-Output $out.ToString()
