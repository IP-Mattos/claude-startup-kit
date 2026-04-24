# Claude Code Daily Brief — runs at Windows login.
# Discreet TOPMOST window with project menu. Picking a project opens it minimized in VS Code
# while the brief stays visible so you can pick more.
# Modular: real logic lives in lib/. This is the orchestrator.

$ErrorActionPreference = "Continue"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
[Console]::InputEncoding  = $utf8NoBom
$Host.UI.RawUI.WindowTitle = "Claude Code  |  Daily Brief"

# -------- Module loading --------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "lib\config.ps1")
. (Join-Path $scriptDir "lib\logging.ps1")
. (Join-Path $scriptDir "lib\scan-projects.ps1")
. (Join-Path $scriptDir "lib\engram.ps1")
. (Join-Path $scriptDir "lib\themes.ps1")
. (Join-Path $scriptDir "lib\git-recent.ps1")
. (Join-Path $scriptDir "lib\github-prs.ps1")
. (Join-Path $scriptDir "lib\self-update.ps1")

Initialize-StartupKitLog
Write-KitLog -Level INFO -Source startup-brief -Message "Brief launched"

$cfg = Get-StartupKitConfig -ConfigDir $scriptDir
Write-KitLog -Level INFO -Source startup-brief -Message ("Config loaded: window={0}x{1} @ {2}px {3}, theme={4}" -f $cfg.window.cols, $cfg.window.lines, $cfg.window.fontSize, $cfg.window.fontName, $cfg.theme)

# Theme
$T = Get-StartupKitTheme -Name $cfg.theme

# -------- Splash (immediately, before any heavy work) --------
$ESC = [char]27
function ColorE { param([string]$Code, [string]$Text) return "$ESC[${Code}m$Text$ESC[0m" }
Clear-Host
Write-Host ""
Write-Host "  $(ColorE $T.GRAY '...cargando brief...')"
Write-Host ""

# -------- Native API imports (one Add-Type = one compile) --------
try {
    Add-Type -Namespace BriefNative -Name Api -MemberDefinition @"
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct COORD { public short X; public short Y; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public struct CONSOLE_FONT_INFOEX {
    public uint cbSize;
    public uint nFont;
    public COORD dwFontSize;
    public int FontFamily;
    public int FontWeight;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst=32)]
    public string FaceName;
}
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern System.IntPtr GetStdHandle(int nStdHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetCurrentConsoleFontEx(System.IntPtr hConsoleOutput, bool MaximumWindow, ref CONSOLE_FONT_INFOEX ConsoleCurrentFontEx);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool MoveWindow(System.IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@ -ErrorAction SilentlyContinue
} catch {}

# Font + window setup
try {
    $h = [BriefNative.Api]::GetStdHandle(-11)
    $cfi = New-Object BriefNative.Api+CONSOLE_FONT_INFOEX
    $cfi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($cfi)
    $cfi.nFont = 0
    $coord = New-Object BriefNative.Api+COORD
    $coord.X = 0; $coord.Y = $cfg.window.fontSize
    $cfi.dwFontSize = $coord
    $cfi.FontFamily = 54; $cfi.FontWeight = 400; $cfi.FaceName = $cfg.window.fontName
    [void][BriefNative.Api]::SetCurrentConsoleFontEx($h, $false, [ref]$cfi)
} catch { Write-KitLog -Level WARN -Source startup-brief -Message "Font bump failed: $($_.Exception.Message)" }

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $hWnd = [BriefNative.Api]::GetConsoleWindow()
    if ($hWnd -ne [System.IntPtr]::Zero) {
        [void][BriefNative.Api]::ShowWindow($hWnd, 4)   # SW_SHOWNOACTIVATE

        $rect = New-Object BriefNative.Api+RECT
        [void][BriefNative.Api]::GetWindowRect($hWnd, [ref]$rect)
        $winW = $rect.Right - $rect.Left
        $winH = $rect.Bottom - $rect.Top
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $x = [int](($screen.Width  - $winW) / 2) + $screen.X
        $y = [int](($screen.Height - $winH) / 2) + $screen.Y
        [void][BriefNative.Api]::MoveWindow($hWnd, $x, $y, $winW, $winH, $true)

        if ($cfg.window.topmost) {
            [System.IntPtr]$HWND_TOPMOST = [System.IntPtr]::new(-1)
            [uint32]$flags = 0x0001 -bor 0x0002 -bor 0x0010
            [void][BriefNative.Api]::SetWindowPos($hWnd, $HWND_TOPMOST, 0, 0, 0, 0, $flags)
        }
    }
} catch { Write-KitLog -Level WARN -Source startup-brief -Message "Window setup failed: $($_.Exception.Message)" }

# -------- Width detection --------
[int]$W = 100
try { [int]$detected = [Console]::WindowWidth; if ($detected -ge 60) { $W = $detected - 2 } } catch {}

# -------- Render helpers --------
function Color { param([string]$Code, [string]$Text) return "$ESC[${Code}m$Text$ESC[0m" }
function HLine { param([int]$Length); if ($Length -lt 1) { return "" }; return ([string]([char]0x2550)) * $Length }
function PrintHr { [Console]::WriteLine("  " + (Color -Code $T.CYAN -Text (HLine -Length $W))) }
function PrintHrTitle {
    param([string]$Title)
    [string]$prefix = (HLine -Length 4) + " "
    [int]$rest = $W - $prefix.Length - $Title.Length - 1
    if ($rest -lt 4) { $rest = 4 }
    [Console]::WriteLine("  " + (Color -Code $T.CYAN -Text ($prefix + $Title + " " + (HLine -Length $rest))))
}

# -------- Scan projects --------
$swScan = [System.Diagnostics.Stopwatch]::StartNew()
$allProjects = @(Get-ClaudeProjects -ActivityWindowDays $cfg.projects.activityWindowDays)
$swScan.Stop()
Write-KitLog -Level INFO -Source startup-brief -Message ("Scanned {0} projects in {1}ms" -f $allProjects.Count, $swScan.ElapsedMilliseconds)

# Pinned projects: lift to the top in user-defined order, then the rest by recency.
$pinned = @()
$rest = @()
$pinnedNames = @()
if ($cfg.PSObject.Properties.Name -contains "pinned" -and $cfg.pinned) {
    $pinnedNames = @($cfg.pinned | ForEach-Object { $_.ToString().ToLowerInvariant() })
}

if ($pinnedNames.Count -gt 0) {
    foreach ($name in $pinnedNames) {
        $hit = $allProjects | Where-Object { (Split-Path $_.Path -Leaf).ToLowerInvariant() -eq $name } | Select-Object -First 1
        if ($hit) { $pinned += $hit }
    }
    $rest = $allProjects | Where-Object {
        $leaf = (Split-Path $_.Path -Leaf).ToLowerInvariant()
        $pinnedNames -notcontains $leaf
    }
} else {
    $rest = $allProjects
}
$projects = @($pinned) + @($rest)

# -------- gentle-ai version --------
[string]$lastSeenFile = "$env:USERPROFILE\.claude\scripts\.gentle-ai-last-seen-version"
[string]$currentVersion = ""
try {
    $verOutput = & gentle-ai version 2>$null
    if ($verOutput -is [array]) { $verOutput = ($verOutput -join "`n") }
    if ($verOutput -match '(\d+\.\d+\.\d+)') { $currentVersion = $matches[1] }
} catch {}

[string]$lastSeen = ""
if (Test-Path $lastSeenFile) { try { $lastSeen = (Get-Content $lastSeenFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {} }
if (-not [string]::IsNullOrWhiteSpace($currentVersion)) {
    try { $currentVersion | Out-File -FilePath $lastSeenFile -Encoding ascii -NoNewline -ErrorAction SilentlyContinue } catch {}
}

# -------- Pre-fetch Engram summaries + recent commits --------
$engramSummaries = @{}
$recentCommits = @{}
if ($projects.Count -gt 0) {
    $recentForBrief = @($projects | Where-Object { $_.DaysAgo -le $cfg.projects.recentForBriefDays })
    if ($cfg.engram.fetchSummariesForBrief) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        foreach ($p in $recentForBrief) {
            $name = Get-EngramProjectName -ProjectPath $p.Path
            if ($name) {
                $goal = Get-EngramProjectGoal -ProjectName $name -MaxChars $cfg.engram.summaryMaxChars
                if ($goal) { $engramSummaries[$p.Path] = $goal }
            }
        }
        $sw.Stop()
        Write-KitLog -Level INFO -Source startup-brief -Message ("Engram summaries: {0}/{1} in {2}ms" -f $engramSummaries.Count, $recentForBrief.Count, $sw.ElapsedMilliseconds)
    }
    if ($cfg.git.showRecentCommitInBrief) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        foreach ($p in $recentForBrief) {
            $info = Get-RecentCommitInfo -ProjectPath $p.Path
            if ($info) { $recentCommits[$p.Path] = $info }
        }
        $sw.Stop()
        Write-KitLog -Level INFO -Source startup-brief -Message ("Git commits: {0}/{1} in {2}ms" -f $recentCommits.Count, $recentForBrief.Count, $sw.ElapsedMilliseconds)
    }
}

# -------- Pre-fetch GitHub PR queue --------
$pendingPRs = $null
if ($cfg.github.showPrQueue) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $pendingPRs = Get-PendingPRs -Limit $cfg.github.prLimit
    $sw.Stop()
    if ($null -ne $pendingPRs) {
        Write-KitLog -Level INFO -Source startup-brief -Message ("PRs awaiting review: {0} in {1}ms" -f $pendingPRs.Count, $sw.ElapsedMilliseconds)
    }
}

# -------- Detect kit update --------
$updateStatus = $null
if ($cfg.selfUpdate.checkOnStart) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
    # If the user is running from ~/.claude/scripts, scriptDir is ~/.claude/scripts
    # and the repo lives elsewhere. Also try the configured repo path.
    if ($cfg.selfUpdate.PSObject.Properties.Name -contains "repoPath" -and $cfg.selfUpdate.repoPath) {
        $repoRoot = $cfg.selfUpdate.repoPath
    }
    if (Test-Path (Join-Path $repoRoot ".git")) {
        $updateStatus = Get-KitUpdateStatus -RepoRoot $repoRoot
        if ($updateStatus.Available) {
            Write-KitLog -Level INFO -Source startup-brief -Message ("Kit update available: behind by {0} commits" -f $updateStatus.Behind)
        }
    }
}

# -------- Render function --------
function Show-Menu {
    Clear-Host
    Write-Host ""
    PrintHr
    Write-Host ""
    [string]$bannerInner = (Color -Code "$($T.BOLD);$($T.MAG)" -Text ">>  CLAUDE CODE") + "   " + (Color -Code $T.GRAY -Text "|") + "   " + (Color -Code "$($T.BOLD);$($T.CYAN)" -Text "DAILY BRIEF")
    Write-Host "    $bannerInner"
    Write-Host ""
    PrintHr
    Write-Host ""
    [string]$today = Get-Date -Format "dddd, MMMM dd, yyyy  -  HH:mm"
    Write-Host "    $(Color -Code $T.GRAY -Text $today)"
    Write-Host ""

    # Self-update banner
    if ($updateStatus -and $updateStatus.Available) {
        Write-Host ("    " + (Color -Code "$($T.BOLD);$($T.YELLOW)" -Text "[!] Update disponible:") + " " +
                    (Color -Code $T.GRAY -Text "v$($updateStatus.LocalHash)") + " -> " +
                    (Color -Code $T.GREEN -Text "v$($updateStatus.RemoteHash)") + "  " +
                    (Color -Code $T.GRAY -Text "(behind by $($updateStatus.Behind) commits)"))
        Write-Host "    $(Color -Code $T.GRAY -Text 'Escribi "u" en el prompt para actualizar el kit.')"
        Write-Host ""
    }

    # gentle-ai
    PrintHrTitle -Title "GENTLE-AI"
    Write-Host ""
    if ([string]::IsNullOrWhiteSpace($currentVersion)) {
        Write-Host "    $(Color -Code $T.YELLOW -Text 'gentle-ai no detectado en el PATH.')"
    } elseif ([string]::IsNullOrWhiteSpace($lastSeen)) {
        Write-Host "    $(Color -Code $T.GRAY -Text 'Version actual:') $(Color -Code "$($T.BOLD);$($T.WHITE)" -Text "v$currentVersion") $(Color -Code $T.GRAY -Text '(primer registro)')"
    } elseif ($lastSeen -eq $currentVersion) {
        Write-Host "    $(Color -Code $T.GRAY -Text 'Version actual:') $(Color -Code "$($T.BOLD);$($T.WHITE)" -Text "v$currentVersion") $(Color -Code $T.GRAY -Text '- sin cambios')"
    } else {
        Write-Host "    $(Color -Code $T.GREEN -Text 'ACTUALIZADO:') $(Color -Code $T.YELLOW -Text "v$lastSeen") -> $(Color -Code "$($T.BOLD);$($T.GREEN)" -Text "v$currentVersion")"
    }
    Write-Host ""

    # GitHub PR queue (only when configured + gh available + something to show)
    if ($cfg.github.showPrQueue -and $null -ne $pendingPRs) {
        PrintHrTitle -Title ("GITHUB PRs  -  esperando tu review ({0})" -f $pendingPRs.Count)
        Write-Host ""
        if ($pendingPRs.Count -eq 0) {
            Write-Host "    $(Color -Code $T.GREEN -Text 'Cero pendientes. ¡A laburar!')"
        } else {
            foreach ($pr in $pendingPRs) {
                $repoFull = if ($pr.repository.nameWithOwner) { $pr.repository.nameWithOwner } else { "?" }
                Write-Host ("    " + (Color -Code $T.CYAN -Text "> ") +
                            (Color -Code "$($T.BOLD);$($T.WHITE)" -Text $pr.title) + "  " +
                            (Color -Code $T.GRAY -Text "($repoFull by $($pr.author.login))"))
            }
        }
        Write-Host ""
    }

    # AYER EN RESUMEN
    PrintHrTitle -Title "AYER EN RESUMEN"
    Write-Host ""
    $recentForBrief = @($projects | Where-Object { $_.DaysAgo -le $cfg.projects.recentForBriefDays })
    if ($recentForBrief.Count -eq 0) {
        Write-Host "    $(Color -Code $T.GRAY -Text 'Sin actividad en las ultimas 48h.')"
    } else {
        foreach ($p in $recentForBrief) {
            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }
            $bullet = (Color -Code $T.CYAN -Text "> ")
            $nameStyled = (Color -Code "$($T.BOLD);$($T.WHITE)" -Text $name)
            $dot = (Color -Code $T.GRAY -Text "|")
            $summaryText = $engramSummaries[$p.Path]
            if (-not $summaryText) { $summaryText = "(sin summary en Engram)" }
            Write-Host "    $bullet$nameStyled  $dot  $(Color -Code $T.GRAY -Text $summaryText)"

            if ($recentCommits.ContainsKey($p.Path)) {
                $c = $recentCommits[$p.Path]
                Write-Host ("        " + (Color -Code $T.GRAY -Text "git: ") +
                            (Color -Code $T.GRAY -Text $c.Hash) + " " +
                            (Color -Code $T.GRAY -Text $c.Subject) + " " +
                            (Color -Code $T.GRAY -Text "($($c.Ago), $($c.Author))"))
            }
        }
    }
    Write-Host ""

    # PROYECTOS ACTIVOS
    PrintHrTitle -Title "PROYECTOS ACTIVOS  -  ultimos $($cfg.projects.activityWindowDays) dias"
    Write-Host ""
    if ($projects.Count -eq 0) {
        Write-Host "    $(Color -Code $T.YELLOW -Text 'Sin proyectos con actividad reciente.')"
    } else {
        [int]$idx = 1
        foreach ($p in $projects) {
            if ($p.DaysAgo -eq 0)      { $label = "hoy";  $labelColor = $T.GREEN }
            elseif ($p.DaysAgo -eq 1)  { $label = "ayer"; $labelColor = $T.GREEN }
            elseif ($p.DaysAgo -le 3)  { $label = "$($p.DaysAgo)d"; $labelColor = $T.YELLOW }
            else                       { $label = "$($p.DaysAgo)d"; $labelColor = $T.GRAY }
            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }
            $isPinned = $pinnedNames -contains $name.ToLowerInvariant()
            $pinIcon = if ($isPinned) { (Color -Code $T.MAG -Text "*") } else { " " }
            $num = "{0,2}" -f $idx
            Write-Host ("    " + $pinIcon + " " + (Color -Code $T.CYAN -Text $num) + ". " +
                        (Color -Code "$($T.BOLD);$($T.WHITE)" -Text $name) + "  " +
                        (Color -Code $T.GRAY -Text ("- " + $p.Path)) + "  " +
                        (Color -Code $labelColor -Text "[$label]"))
            $idx++
        }
        Write-Host ""
        Write-Host "    $(Color -Code $T.GRAY -Text 'Quick actions:') $(Color -Code $T.WHITE -Text 'N')$(Color -Code $T.GRAY -Text ' = abrir VS Code  |  ')$(Color -Code $T.WHITE -Text 'N t')$(Color -Code $T.GRAY -Text ' = terminal  |  ')$(Color -Code $T.WHITE -Text 'N g')$(Color -Code $T.GRAY -Text ' = git status  |  ')$(Color -Code $T.WHITE -Text 'N l')$(Color -Code $T.GRAY -Text ' = git log  |  ')$(Color -Code $T.WHITE -Text 'N e')$(Color -Code $T.GRAY -Text ' = explorer  |  ')$(Color -Code $T.WHITE -Text 'N c')$(Color -Code $T.GRAY -Text ' = copy path')"
        Write-Host "    $(Color -Code $T.GRAY -Text 'Comandos:') $(Color -Code $T.WHITE -Text 'q')$(Color -Code $T.GRAY -Text ' = salir  |  ')$(Color -Code $T.WHITE -Text 'r')$(Color -Code $T.GRAY -Text ' = refrescar')$(if ($updateStatus -and $updateStatus.Available) { (Color -Code $T.GRAY -Text '  |  ') + (Color -Code $T.WHITE -Text 'u') + (Color -Code $T.GRAY -Text ' = actualizar kit') } else { '' })"
    }
    Write-Host ""
    PrintHr
    Write-Host ""
}

# -------- Empty path --------
if ($projects.Count -eq 0) {
    Show-Menu
    Write-Host "    $(Color -Code $T.GRAY -Text 'Presiona ENTER para cerrar...')"
    Read-Host | Out-Null
    Write-KitLog -Level INFO -Source startup-brief -Message "Closed (no projects)"
    exit 0
}

Show-Menu

# -------- Action handlers --------
function Open-VSCodeWorkspace {
    param([Parameter(Mandatory=$true)][string]$Path, [string]$Name)
    [string]$folderUri = "file:///" + ($Path -replace '\\', '/')
    $cmdArgs = @("--folder-uri", "`"$folderUri`"")
    if ($cfg.vsCode.openInNewWindow) { $cmdArgs = @("--new-window") + $cmdArgs }
    & cmd.exe /c ("code.cmd " + ($cmdArgs -join " "))
    Write-KitLog -Level INFO -Source startup-brief -Message ("Opened VS Code for '$Name'")

    if ($cfg.vsCode.minimizeAfterLaunch) {
        try {
            [string]$expectedTitle = "$Name - Visual Studio Code"
            $vscodeHwnd = [System.IntPtr]::Zero
            for ($i = 0; $i -lt 25; $i++) {
                Start-Sleep -Milliseconds 200
                $vscodeHwnd = [BriefNative.Api]::FindWindow($null, $expectedTitle)
                if ($vscodeHwnd -ne [System.IntPtr]::Zero) { break }
            }
            if ($vscodeHwnd -ne [System.IntPtr]::Zero) {
                [void][BriefNative.Api]::ShowWindow($vscodeHwnd, 6)   # SW_MINIMIZE
            }
        } catch {}
    }
}

function Open-TerminalAt {
    param([Parameter(Mandatory=$true)][string]$Path)
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$Path`"" -WindowStyle Normal
    Write-KitLog -Level INFO -Source startup-brief -Message "Opened terminal at $Path"
}

function Show-GitStatus {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "    $(Color -Code $T.RED -Text 'git no esta en el PATH.')"; return }
    if (-not (Test-Path (Join-Path $Path ".git"))) { Write-Host "    $(Color -Code $T.YELLOW -Text 'No es un repo git.')"; return }
    Write-Host ""
    & git -C $Path -c color.status=always status -sb
    Write-Host ""
    Write-Host "    $(Color -Code $T.GRAY -Text '(presiona ENTER para volver)')"
    Read-Host | Out-Null
}

function Show-GitLog {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "    $(Color -Code $T.RED -Text 'git no esta en el PATH.')"; return }
    if (-not (Test-Path (Join-Path $Path ".git"))) { Write-Host "    $(Color -Code $T.YELLOW -Text 'No es un repo git.')"; return }
    Write-Host ""
    & git -C $Path -c color.ui=always log --oneline -10 --decorate --graph
    Write-Host ""
    Write-Host "    $(Color -Code $T.GRAY -Text '(presiona ENTER para volver)')"
    Read-Host | Out-Null
}

function Open-Explorer {
    param([Parameter(Mandatory=$true)][string]$Path)
    Start-Process -FilePath "explorer.exe" -ArgumentList $Path
    Write-KitLog -Level INFO -Source startup-brief -Message "Opened explorer at $Path"
}

function Copy-PathToClipboard {
    param([Parameter(Mandatory=$true)][string]$Path)
    Set-Clipboard -Value $Path
    Write-Host "    $(Color -Code $T.GREEN -Text '> Copiado al clipboard:') $(Color -Code $T.WHITE -Text $Path)"
    Start-Sleep -Milliseconds 800
}

# -------- Prompt loop --------
while ($true) {
    Write-Host -NoNewline ("    " + (Color -Code $T.BOLD -Text "Que abris hoy?") + " " + (Color -Code $T.GRAY -Text "[N | N letra | q/r]") + (Color -Code $T.CYAN -Text " > "))
    [string]$selection = (Read-Host).Trim()

    if ([string]::IsNullOrWhiteSpace($selection)) {
        Write-Host "    $(Color -Code $T.GRAY -Text 'Sin seleccion. Cerrando.')"
        Write-KitLog -Level INFO -Source startup-brief -Message "Closed (empty input)"
        Start-Sleep -Seconds 1
        exit 0
    }

    # Single-letter commands
    switch ($selection.ToLowerInvariant()) {
        "q"     { Write-Host "    $(Color -Code $T.GRAY -Text 'Buen laburo hoy!')"; Write-KitLog -Level INFO -Source startup-brief -Message "Closed (q)"; Start-Sleep -Seconds 1; exit 0 }
        "salir" { Write-Host "    $(Color -Code $T.GRAY -Text 'Buen laburo hoy!')"; Write-KitLog -Level INFO -Source startup-brief -Message "Closed (salir)"; Start-Sleep -Seconds 1; exit 0 }
        "r"     { Write-KitLog -Level INFO -Source startup-brief -Message "Refresh"; Show-Menu; continue }
        "u"     {
            if ($updateStatus -and $updateStatus.Available) {
                Write-Host "    $(Color -Code $T.YELLOW -Text 'Actualizando kit...')"
                $r = Invoke-KitUpdate -RepoRoot $cfg.selfUpdate.repoPath
                if ($r.Success) {
                    Write-Host "    $(Color -Code $T.GREEN -Text $r.Message)"
                } else {
                    Write-Host "    $(Color -Code $T.RED -Text "Update fallo: $($r.Message)")"
                }
                Write-Host "    $(Color -Code $T.GRAY -Text 'Presiona ENTER para continuar.')"
                Read-Host | Out-Null
                Show-Menu
                continue
            } else {
                Write-Host "    $(Color -Code $T.GRAY -Text 'Sin updates disponibles.')"
                continue
            }
        }
    }

    # Pattern: "<num>" or "<num> <letter>"
    if ($selection -notmatch '^(\d+)(\s+([a-z]))?$') {
        Write-Host "    $(Color -Code $T.RED -Text 'Formato invalido. Tipea N o "N letra" (t/g/l/e/c).')"
        continue
    }

    [int]$choice = [int]$matches[1]
    [string]$action = if ($matches[3]) { $matches[3] } else { "" }

    if ($choice -lt 1 -or $choice -gt $projects.Count) {
        Write-Host "    $(Color -Code $T.RED -Text "Numero fuera de rango. Elegi entre 1 y $($projects.Count).")"
        continue
    }

    $picked = $projects[$choice - 1]
    [string]$pickedName = Split-Path $picked.Path -Leaf

    switch ($action) {
        ""  {
            Write-Host ""
            Write-Host ("    " + (Color -Code $T.GREEN -Text "> Abriendo VS Code:") + "  " + (Color -Code $T.BOLD -Text $pickedName))
            Write-Host ""
            Open-VSCodeWorkspace -Path $picked.Path -Name $pickedName
            Show-Menu
        }
        "t" {
            Write-Host "    $(Color -Code $T.GREEN -Text "> Terminal en") $(Color -Code $T.BOLD -Text $pickedName)"
            Open-TerminalAt -Path $picked.Path
            Start-Sleep -Milliseconds 600
            Show-Menu
        }
        "g" {
            Write-Host "    $(Color -Code $T.GREEN -Text "> git status:") $(Color -Code $T.BOLD -Text $pickedName)"
            Show-GitStatus -Path $picked.Path
            Show-Menu
        }
        "l" {
            Write-Host "    $(Color -Code $T.GREEN -Text "> git log:") $(Color -Code $T.BOLD -Text $pickedName)"
            Show-GitLog -Path $picked.Path
            Show-Menu
        }
        "e" {
            Write-Host "    $(Color -Code $T.GREEN -Text "> Explorer:") $(Color -Code $T.BOLD -Text $pickedName)"
            Open-Explorer -Path $picked.Path
            Start-Sleep -Milliseconds 600
            Show-Menu
        }
        "c" {
            Copy-PathToClipboard -Path $picked.Path
            Show-Menu
        }
        default {
            Write-Host "    $(Color -Code $T.RED -Text "Accion '$action' desconocida. Usar t/g/l/e/c.")"
        }
    }
}
