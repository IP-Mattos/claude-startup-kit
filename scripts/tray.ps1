# Claude Startup Kit — system tray daemon.
# Permanent process that puts an icon in the Windows notification area.
#   - Left click  → open the brief (same window the boot launcher opens)
#   - Right click → context menu with quick actions
#   - Tooltip shows live status (project count, audit, kit version)
#   - Native Windows balloon notifications when audit finds CRIT
#
# Single-instance enforced. Auto-discovers other tray instances and exits.
#
# Run via: tray-launcher.bat (in Startup folder for boot, or `briefray` from PATH).

$ErrorActionPreference = "Continue"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8NoBom

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -------- Single-instance guard --------
$mutexName = "Global\ClaudeStartupKitTrayDaemon"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    # Another tray daemon is already running. Don't start a second one.
    [System.Console]::Error.WriteLine("[tray] another instance is already running — exiting")
    exit 0
}

# -------- Module loading (for stats) --------
. (Join-Path $scriptDir "lib\config.ps1")
. (Join-Path $scriptDir "lib\logging.ps1")
. (Join-Path $scriptDir "lib\scan-projects.ps1")
Initialize-StartupKitLog
Write-KitLog -Level INFO -Source tray -Message "Tray daemon started"

$cfg = Get-StartupKitConfig -ConfigDir $scriptDir

# -------- Win32 imports --------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# -------- Build a simple icon (cyan circle on transparent bg) --------
function New-TrayIcon {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    # Outer ring
    $penOuter = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 100, 200, 255)), 3
    $g.DrawEllipse($penOuter, 3, 3, 26, 26)
    # Inner dot
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 100, 200))
    $g.FillEllipse($brush, 12, 12, 8, 8)
    $g.Dispose()
    $iconHandle = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($iconHandle)
}

# -------- Stats + tooltip --------
function Get-TrayTooltip {
    $kitVerFile = Join-Path $scriptDir ".kit-version"
    $kitVer = "?"
    if (Test-Path $kitVerFile) { $kitVer = (Get-Content $kitVerFile -Raw).Trim() }

    $projects = @(Get-ClaudeProjects -ActivityWindowDays $cfg.projects.activityWindowDays)
    $todayCount = @($projects | Where-Object { $_.DaysAgo -le 1 }).Count

    $auditState = Join-Path $scriptDir ".audit-summary.json"
    $auditStatus = "—"
    if (Test-Path $auditState) {
        try {
            $a = Get-Content $auditState -Raw | ConvertFrom-Json
            if ([int]$a.Crit -gt 0)      { $auditStatus = "$($a.Crit) crit" }
            elseif ([int]$a.Warn -gt 0)  { $auditStatus = "$($a.Warn) warn" }
            else                          { $auditStatus = "clean" }
        } catch {}
    }

    # NotifyIcon.Text is hard-capped at 63 chars on this Windows build.
    # Single line, terse: "Kit v2.9.1 · 7 proj (4 today) · clean"
    $tt = "Kit v$kitVer · $($projects.Count) proj ($todayCount today) · $auditStatus"
    if ($tt.Length -gt 63) { $tt = $tt.Substring(0, 60) + "..." }
    return $tt
}

# -------- Action handlers --------
function Open-Brief {
    $launcher = Join-Path $scriptDir "startup-brief-launcher.bat"
    if (Test-Path $launcher) {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $launcher -WindowStyle Hidden
        Write-KitLog -Level INFO -Source tray -Message "Brief launched from tray"
    }
}

function Run-Audit {
    $auditScript = Join-Path $scriptDir "claude-audit.ps1"
    if (Test-Path $auditScript) {
        Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-NoExit", "-File", $auditScript -WindowStyle Normal
        Write-KitLog -Level INFO -Source tray -Message "Audit launched from tray"
    }
}

function Run-Cleanup {
    $cleanupScript = Join-Path $scriptDir "cleanup.ps1"
    if (Test-Path $cleanupScript) {
        Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-NoExit", "-File", $cleanupScript, "-DryRun" -WindowStyle Normal
        Write-KitLog -Level INFO -Source tray -Message "Cleanup launched from tray"
    }
}

function Show-Logs {
    $logFile = Join-Path $env:USERPROFILE ".claude\logs\startup-kit.log"
    if (Test-Path $logFile) {
        Start-Process -FilePath "notepad.exe" -ArgumentList $logFile
    }
}

function Open-ConfigFile {
    $configPath = Join-Path $scriptDir "startup-kit-config.json"
    if (Test-Path $configPath) {
        $codeCmd = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source
        if ($codeCmd) {
            & cmd.exe /c "code.cmd `"$configPath`""
        } else {
            Start-Process -FilePath "notepad.exe" -ArgumentList $configPath
        }
    }
}

# -------- Build the form + tray icon --------
$form = New-Object System.Windows.Forms.Form
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.ShowInTaskbar = $false
$form.Visible = $false

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-TrayIcon
$tray.Text = Get-TrayTooltip
$tray.Visible = $true

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add("Abrir brief")
$miOpen.add_Click({ Open-Brief })

$null = $menu.Items.Add("-")    # separator

$miAudit = $menu.Items.Add("Run audit")
$miAudit.add_Click({ Run-Audit })

$miCleanup = $menu.Items.Add("Cleanup preview")
$miCleanup.add_Click({ Run-Cleanup })

$miLogs = $menu.Items.Add("View logs")
$miLogs.add_Click({ Show-Logs })

$null = $menu.Items.Add("-")

$miConfig = $menu.Items.Add("Settings (config.json)")
$miConfig.add_Click({ Open-ConfigFile })

$miAbout = $menu.Items.Add("About...")
$miAbout.add_Click({
    $kitVerFile = Join-Path $scriptDir ".kit-version"
    $kitVer = "?"
    if (Test-Path $kitVerFile) { $kitVer = (Get-Content $kitVerFile -Raw).Trim() }
    $msg = "Claude Startup Kit v$kitVer`n`nRepo: $($cfg.selfUpdate.repoPath)`nLogs: $env:USERPROFILE\.claude\logs\startup-kit.log"
    [void][System.Windows.Forms.MessageBox]::Show($msg, "Claude Startup Kit", "OK", "Information")
})

$null = $menu.Items.Add("-")

$miQuit = $menu.Items.Add("Quit tray")
$miQuit.add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    Write-KitLog -Level INFO -Source tray -Message "Tray daemon stopped from menu"
    $form.Close()
    [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# Left click → open brief
$tray.add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Open-Brief
    }
})

# -------- Periodic refresh of tooltip + audit-CRIT alerts --------
$lastAlertedCrit = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000   # 60 seconds
$timer.add_Tick({
    try {
        $tray.Text = Get-TrayTooltip
        $auditState = Join-Path $scriptDir ".audit-summary.json"
        if (Test-Path $auditState) {
            $a = Get-Content $auditState -Raw | ConvertFrom-Json
            $crit = [int]$a.Crit
            if ($crit -gt 0 -and $crit -ne $script:lastAlertedCrit) {
                $tray.BalloonTipTitle = "Claude Startup Kit — CRITICAL"
                $tray.BalloonTipText = "$crit critical finding(s). Right-click → Run audit."
                $tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
                $tray.ShowBalloonTip(5000)
                $script:lastAlertedCrit = $crit
                Write-KitLog -Level WARN -Source tray -Message "Tray showed CRIT balloon for $crit finding(s)"
            } elseif ($crit -eq 0) {
                $script:lastAlertedCrit = 0
            }
        }
    } catch {}
})
$timer.Start()

# -------- Run --------
[System.Windows.Forms.Application]::Run($form)

# Cleanup on exit
$tray.Visible = $false
$tray.Dispose()
$timer.Stop()
$mutex.ReleaseMutex()
