# Native PowerShell project scanner — replaces the Python subprocess.
# Walks ~/.claude/projects/, reads the newest JSONL per project to extract `cwd`,
# filters by activity window + folder existence, returns a sorted list.

function Get-ClaudeProjects {
    param(
        [Parameter(Mandatory=$true)][int]$ActivityWindowDays
    )

    $projectsDir = Join-Path $env:USERPROFILE ".claude\projects"
    if (-not (Test-Path $projectsDir)) { return @() }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $cutoff = $now - ($ActivityWindowDays * 86400)
    $entries = New-Object System.Collections.Generic.List[PSObject]

    foreach ($pdir in Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue) {
        $jsonls = Get-ChildItem -Path $pdir.FullName -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                  Sort-Object -Property LastWriteTime -Descending
        if ($jsonls.Count -eq 0) { continue }

        # Use newest JSONL mtime, NOT folder mtime (NTFS doesn't update folder mtime
        # when files inside are modified — only on create/delete).
        $newest = $jsonls[0]
        $mtime = [int][double]([DateTimeOffset]::new($newest.LastWriteTimeUtc).ToUnixTimeSeconds())
        if ($mtime -lt $cutoff) { continue }

        # Find the first line in any jsonl that has a "cwd" field
        $cwd = $null
        foreach ($jp in $jsonls) {
            try {
                $reader = [System.IO.StreamReader]::new($jp.FullName, [System.Text.Encoding]::UTF8)
                while (-not $reader.EndOfStream) {
                    $line = $reader.ReadLine()
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }
                    try {
                        $obj = $line | ConvertFrom-Json -ErrorAction Stop
                    } catch { continue }
                    if ($obj -and $obj.PSObject.Properties.Name -contains "cwd" -and $obj.cwd) {
                        $cwd = [string]$obj.cwd
                        break
                    }
                }
                $reader.Close()
                if ($cwd) { break }
            } catch {
                if ($reader) { try { $reader.Close() } catch {} }
            }
        }

        if (-not $cwd) { continue }

        # Skip projects whose folder no longer exists on disk (user moved/deleted them).
        if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { continue }

        $daysAgo = [int][math]::Floor(($now - $mtime) / 86400)
        $lastDate = [DateTimeOffset]::FromUnixTimeSeconds($mtime).LocalDateTime.ToString("yyyy-MM-dd")

        $entries.Add([PSCustomObject]@{
            Mtime    = $mtime
            DaysAgo  = $daysAgo
            LastDate = $lastDate
            Path     = $cwd
        })
    }

    return $entries | Sort-Object -Property Mtime -Descending
}
