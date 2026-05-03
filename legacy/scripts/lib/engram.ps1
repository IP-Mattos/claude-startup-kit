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

# Lazy-cached list of project names known to Engram (lowercase).
$script:EngramProjectsCache = $null
function Get-EngramKnownProjects {
    if ($null -ne $script:EngramProjectsCache) { return $script:EngramProjectsCache }
    if (-not (Get-Command engram -ErrorAction SilentlyContinue)) {
        $script:EngramProjectsCache = @()
        return $script:EngramProjectsCache
    }
    try {
        $out = & engram projects list 2>$null
        if (-not $out) { $script:EngramProjectsCache = @(); return @() }
        if ($out -is [array]) { $out = ($out -join "`n") }
        # Engram's `projects list` output format may evolve; pull anything that
        # looks like a project token. We accept lines like "name (...)" or just "name".
        $names = New-Object System.Collections.Generic.List[string]
        foreach ($line in ($out -split "`r?`n")) {
            $trimmed = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
            if ($trimmed -match '^[\-\=\#]') { continue }   # decorative lines
            if ($trimmed -match '^([A-Za-z0-9][A-Za-z0-9._\-]+)') {
                $names.Add($matches[1].ToLowerInvariant())
            }
        }
        $script:EngramProjectsCache = @($names | Select-Object -Unique)
        return $script:EngramProjectsCache
    } catch {
        $script:EngramProjectsCache = @()
        return @()
    }
}

# Try to find the engram project name that best matches a folder leaf.
# Strategy: exact match → prefix match → contains match. Returns $null if none.
function Resolve-EngramProjectName {
    param([Parameter(Mandatory=$true)][string]$FolderLeaf)
    $known = Get-EngramKnownProjects
    if ($known.Count -eq 0) { return $FolderLeaf.ToLowerInvariant() }
    $needle = $FolderLeaf.ToLowerInvariant()
    if ($known -contains $needle) { return $needle }
    $prefix = @($known | Where-Object { $_.StartsWith($needle) -or $needle.StartsWith($_) } | Select-Object -First 1)
    if ($prefix.Count -gt 0) { return $prefix[0] }
    $contains = @($known | Where-Object { $_.Contains($needle) -or $needle.Contains($_) } | Select-Object -First 1)
    if ($contains.Count -gt 0) { return $contains[0] }
    return $needle  # fall back to the leaf — let the search miss explicitly
}
