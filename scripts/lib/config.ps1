# Loads user config (or defaults) for the Claude Startup Kit.
# Returns a PSCustomObject with merged values.

function Get-StartupKitConfig {
    param([string]$ConfigDir)

    $defaults = [PSCustomObject]@{
        theme    = "default"
        window   = [PSCustomObject]@{
            cols           = 120
            lines          = 32
            fontSize       = 14
            fontName       = "Consolas"
            topmost        = $true
            startMinimized = $true
        }
        projects = [PSCustomObject]@{
            activityWindowDays  = 14
            recentForBriefDays  = 2
        }
        vsCode   = [PSCustomObject]@{
            minimizeAfterLaunch = $true
            openInNewWindow     = $true
        }
        engram   = [PSCustomObject]@{
            fetchSummariesForBrief = $true
            summaryMaxChars        = 90
        }
        git = [PSCustomObject]@{
            showRecentCommitInBrief = $true
        }
        github = [PSCustomObject]@{
            showPrQueue = $false   # off by default — requires gh authenticated
            prLimit     = 5
        }
        selfUpdate = [PSCustomObject]@{
            checkOnStart = $true
            repoPath     = ""
        }
        pinned = @()
    }

    $userPath = Join-Path $ConfigDir "startup-kit-config.json"
    if (-not (Test-Path $userPath)) { return $defaults }

    try {
        $userRaw = Get-Content $userPath -Raw
        $user = $userRaw | ConvertFrom-Json -ErrorAction Stop

        foreach ($section in @("window", "projects", "vsCode", "engram", "git", "github", "selfUpdate")) {
            if ($user.PSObject.Properties.Name -contains $section -and $user.$section) {
                foreach ($prop in $user.$section.PSObject.Properties) {
                    $defaults.$section.$($prop.Name) = $prop.Value
                }
            }
        }
        if ($user.PSObject.Properties.Name -contains "theme")  { $defaults.theme = $user.theme }
        if ($user.PSObject.Properties.Name -contains "pinned") { $defaults.pinned = @($user.pinned) }
        return $defaults
    } catch {
        Write-Host "[config] WARN: failed to parse $userPath ($($_.Exception.Message)) — falling back to defaults" -ForegroundColor Yellow
        return $defaults
    }
}
