# Git helpers — read the latest commit info from a project folder.

function Get-RecentCommitInfo {
    param([Parameter(Mandatory=$true)][string]$ProjectPath)

    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { return $null }
    $gitDir = Join-Path $ProjectPath ".git"
    if (-not (Test-Path $gitDir)) { return $null }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }

    try {
        $pretty = '%h|%cr|%an|%s'
        $line = & git -C $ProjectPath log -1 --pretty=format:$pretty 2>$null
        if ([string]::IsNullOrWhiteSpace($line)) { return $null }

        $parts = $line -split '\|', 4
        if ($parts.Count -lt 4) { return $null }

        return [PSCustomObject]@{
            Hash    = $parts[0]
            Ago     = $parts[1]
            Author  = $parts[2]
            Subject = $parts[3]
        }
    } catch {
        return $null
    }
}
