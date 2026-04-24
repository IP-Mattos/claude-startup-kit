# Wrapper around the `engram` CLI for the startup brief.
# Returns a one-line "Goal" excerpt from the most recent session_summary in the given project,
# or $null if engram is unavailable / no summaries exist / parsing fails.

function Get-EngramProjectGoal {
    param(
        [Parameter(Mandatory=$true)][string]$ProjectName,
        [int]$MaxChars = 90
    )

    if (-not (Get-Command engram -ErrorAction SilentlyContinue)) {
        return $null
    }

    try {
        # `engram search "session summary" --project <name> --type session_summary --limit 1`
        # Output is human-formatted with previews. We grep for the "## Goal" section and
        # return the first non-empty line after it.
        $out = & engram search "session summary" --project $ProjectName --type session_summary --limit 1 2>$null
        if (-not $out) { return $null }
        if ($out -is [array]) { $out = ($out -join "`n") }

        # Find the Goal section. Match "## Goal" then capture next non-empty line.
        if ($out -match '(?ims)##\s*Goal\s*(?:\r?\n)+\s*(.+?)(\r?\n|$)') {
            $goal = $matches[1].Trim()
            if ($goal.Length -gt $MaxChars) {
                $goal = $goal.Substring(0, $MaxChars - 1) + "…"
            }
            return $goal
        }
        return $null
    } catch {
        return $null
    }
}

function Get-EngramProjectName {
    param([Parameter(Mandatory=$true)][string]$ProjectPath)
    # Engram normalizes project names to lowercase folder names by default.
    $leaf = Split-Path $ProjectPath -Leaf
    if ([string]::IsNullOrWhiteSpace($leaf)) { return $null }
    return $leaf.ToLowerInvariant()
}
