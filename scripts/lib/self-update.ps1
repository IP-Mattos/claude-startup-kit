# Detects whether the local kit clone is behind origin/main.
# Returns a status object the brief uses to render an update banner.

function Get-KitUpdateStatus {
    param([Parameter(Mandatory=$true)][string]$RepoRoot)

    $result = [PSCustomObject]@{
        Available  = $false
        LocalHash  = $null
        RemoteHash = $null
        Behind     = 0
        Error      = $null
    }

    if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
        $result.Error = "Not a git repo"
        return $result
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        $result.Error = "git not on PATH"
        return $result
    }

    try {
        $localHash  = (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
        # fetch quietly; failure is fine (offline)
        & git -C $RepoRoot fetch --quiet origin main 2>$null | Out-Null
        $remoteHash = (& git -C $RepoRoot rev-parse origin/main 2>$null).Trim()

        $result.LocalHash  = $localHash.Substring(0, [math]::Min(7, $localHash.Length))
        $result.RemoteHash = $remoteHash.Substring(0, [math]::Min(7, $remoteHash.Length))

        if ($localHash -and $remoteHash -and $localHash -ne $remoteHash) {
            # How many commits behind?
            $behind = (& git -C $RepoRoot rev-list --count "$localHash..$remoteHash" 2>$null).Trim()
            if ($behind -match '^\d+$' -and [int]$behind -gt 0) {
                $result.Available = $true
                $result.Behind = [int]$behind
            }
        }
        return $result
    } catch {
        $result.Error = $_.Exception.Message
        return $result
    }
}

function Invoke-KitUpdate {
    param([Parameter(Mandatory=$true)][string]$RepoRoot)

    if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
        return [PSCustomObject]@{ Success = $false; Message = "Not a git repo" }
    }

    try {
        $pull = & git -C $RepoRoot pull --ff-only origin main 2>&1
        $installScript = Join-Path $RepoRoot "install.ps1"
        if (Test-Path $installScript) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript | Out-Null
            return [PSCustomObject]@{ Success = $true; Message = "Pulled and reinstalled. Reopen the brief to see changes." }
        }
        return [PSCustomObject]@{ Success = $true; Message = "Pulled. install.ps1 not found in repo root." }
    } catch {
        return [PSCustomObject]@{ Success = $false; Message = $_.Exception.Message }
    }
}
