# File-based logger for the Claude Startup Kit.
# Writes to ~/.claude/logs/startup-kit.log so the user can debug silent failures.

$script:LogPath = Join-Path $env:USERPROFILE ".claude\logs\startup-kit.log"

function Initialize-StartupKitLog {
    $logDir = Split-Path $script:LogPath -Parent
    if (-not (Test-Path $logDir)) {
        try { New-Item -ItemType Directory -Path $logDir -Force | Out-Null } catch {}
    }
}

function Write-KitLog {
    param(
        [Parameter(Mandatory=$true)][string]$Level,    # INFO, WARN, ERROR
        [Parameter(Mandatory=$true)][string]$Source,   # which script
        [Parameter(Mandatory=$true)][string]$Message
    )
    try {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $line = "[$stamp] [$Level] [$Source] $Message"
        Add-Content -Path $script:LogPath -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    } catch {
        # Logging must never crash the caller
    }
}
