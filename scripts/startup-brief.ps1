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

Initialize-StartupKitLog
Write-KitLog -Level INFO -Source startup-brief -Message "Brief launched"

$cfg = Get-StartupKitConfig -ConfigDir $scriptDir
Write-KitLog -Level INFO -Source startup-brief -Message ("Config loaded: window={0}x{1} @ {2}px {3}" -f $cfg.window.cols, $cfg.window.lines, $cfg.window.fontSize, $cfg.window.fontName)

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

# Font bump
try {
    $h = [BriefNative.Api]::GetStdHandle(-11)
    $cfi = New-Object BriefNative.Api+CONSOLE_FONT_INFOEX
    $cfi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($cfi)
    $cfi.nFont = 0
    $coord = New-Object BriefNative.Api+COORD
    $coord.X = 0; $coord.Y = $cfg.window.fontSize
    $cfi.dwFontSize = $coord
    $cfi.FontFamily = 54
    $cfi.FontWeight = 400
    $cfi.FaceName = $cfg.window.fontName
    [void][BriefNative.Api]::SetCurrentConsoleFontEx($h, $false, [ref]$cfi)
} catch {
    Write-KitLog -Level WARN -Source startup-brief -Message "Font bump failed: $($_.Exception.Message)"
}

# Restore (without focus) + center + topmost
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
            [uint32]$flags = 0x0001 -bor 0x0002 -bor 0x0010   # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
            [void][BriefNative.Api]::SetWindowPos($hWnd, $HWND_TOPMOST, 0, 0, 0, 0, $flags)
        }
    }
} catch {
    Write-KitLog -Level WARN -Source startup-brief -Message "Window setup failed: $($_.Exception.Message)"
}

# -------- Width detection --------
[int]$W = 100
try {
    [int]$detected = [Console]::WindowWidth
    if ($detected -ge 60) { $W = $detected - 2 }
} catch {}

# -------- Colors --------
$ESC = [char]27
function Color { param([string]$Code, [string]$Text) return "$ESC[${Code}m$Text$ESC[0m" }
$CYAN="38;5;51"; $MAG="38;5;207"; $GREEN="38;5;42"; $YELLOW="38;5;220"
$GRAY="38;5;245"; $RED="38;5;203"; $WHITE="38;5;255"; $BOLD="1"

function HLine { param([int]$Length); if ($Length -lt 1) { return "" }; return ([string]([char]0x2550)) * $Length }
function PrintHr { [Console]::WriteLine("  " + (Color -Code $CYAN -Text (HLine -Length $W))) }
function PrintHrTitle {
    param([string]$Title)
    [string]$prefix = (HLine -Length 4) + " "
    [int]$rest = $W - $prefix.Length - $Title.Length - 1
    if ($rest -lt 4) { $rest = 4 }
    [Console]::WriteLine("  " + (Color -Code $CYAN -Text ($prefix + $Title + " " + (HLine -Length $rest))))
}

# -------- Scan projects (native PS, no Python subprocess) --------
$swScan = [System.Diagnostics.Stopwatch]::StartNew()
$projects = @(Get-ClaudeProjects -ActivityWindowDays $cfg.projects.activityWindowDays)
$swScan.Stop()
Write-KitLog -Level INFO -Source startup-brief -Message ("Scanned {0} projects in {1}ms" -f $projects.Count, $swScan.ElapsedMilliseconds)

# -------- gentle-ai version check (once) --------
[string]$lastSeenFile = "$env:USERPROFILE\.claude\scripts\.gentle-ai-last-seen-version"
[string]$currentVersion = ""
try {
    $verOutput = & gentle-ai version 2>$null
    if ($verOutput -is [array]) { $verOutput = ($verOutput -join "`n") }
    if ($verOutput -match '(\d+\.\d+\.\d+)') { $currentVersion = $matches[1] }
} catch {}

[string]$lastSeen = ""
if (Test-Path $lastSeenFile) {
    try { $lastSeen = (Get-Content $lastSeenFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
}
if (-not [string]::IsNullOrWhiteSpace($currentVersion)) {
    try { $currentVersion | Out-File -FilePath $lastSeenFile -Encoding ascii -NoNewline -ErrorAction SilentlyContinue } catch {}
}

# -------- Pre-fetch Engram summaries (once, before render) --------
$engramSummaries = @{}
if ($cfg.engram.fetchSummariesForBrief -and $projects.Count -gt 0) {
    $swEngram = [System.Diagnostics.Stopwatch]::StartNew()
    $recentForBrief = @($projects | Where-Object { $_.DaysAgo -le $cfg.projects.recentForBriefDays })
    foreach ($p in $recentForBrief) {
        $name = Get-EngramProjectName -ProjectPath $p.Path
        if ($name) {
            $goal = Get-EngramProjectGoal -ProjectName $name -MaxChars $cfg.engram.summaryMaxChars
            if ($goal) { $engramSummaries[$p.Path] = $goal }
        }
    }
    $swEngram.Stop()
    Write-KitLog -Level INFO -Source startup-brief -Message ("Engram summaries: {0}/{1} projects in {2}ms" -f $engramSummaries.Count, $recentForBrief.Count, $swEngram.ElapsedMilliseconds)
}

# -------- Render function --------
function Show-Menu {
    Clear-Host
    Write-Host ""
    PrintHr
    Write-Host ""
    [string]$bannerInner = (Color -Code "$BOLD;$MAG" -Text ">>  CLAUDE CODE") + "   " + (Color -Code $GRAY -Text "|") + "   " + (Color -Code "$BOLD;$CYAN" -Text "DAILY BRIEF")
    Write-Host "    $bannerInner"
    Write-Host ""
    PrintHr
    Write-Host ""
    [string]$today = Get-Date -Format "dddd, MMMM dd, yyyy  -  HH:mm"
    Write-Host "    $(Color -Code $GRAY -Text $today)"
    Write-Host ""

    # gentle-ai
    PrintHrTitle -Title "GENTLE-AI"
    Write-Host ""
    if ([string]::IsNullOrWhiteSpace($currentVersion)) {
        Write-Host "    $(Color -Code $YELLOW -Text 'gentle-ai no detectado en el PATH.')"
    } elseif ([string]::IsNullOrWhiteSpace($lastSeen)) {
        Write-Host "    $(Color -Code $GRAY -Text 'Version actual:') $(Color -Code "$BOLD;$WHITE" -Text "v$currentVersion") $(Color -Code $GRAY -Text '(primer registro)')"
    } elseif ($lastSeen -eq $currentVersion) {
        Write-Host "    $(Color -Code $GRAY -Text 'Version actual:') $(Color -Code "$BOLD;$WHITE" -Text "v$currentVersion") $(Color -Code $GRAY -Text '- sin cambios desde la ultima vez')"
    } else {
        Write-Host "    $(Color -Code $GREEN -Text 'ACTUALIZADO:') $(Color -Code $YELLOW -Text "v$lastSeen") -> $(Color -Code "$BOLD;$GREEN" -Text "v$currentVersion")"
    }
    Write-Host ""

    # AYER EN RESUMEN (real Engram data when available)
    PrintHrTitle -Title "AYER EN RESUMEN"
    Write-Host ""
    $recentForBrief = @($projects | Where-Object { $_.DaysAgo -le $cfg.projects.recentForBriefDays })
    if ($recentForBrief.Count -eq 0) {
        Write-Host "    $(Color -Code $GRAY -Text 'Sin actividad en las ultimas 48h.')"
    } else {
        foreach ($p in $recentForBrief) {
            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }
            $bullet = (Color -Code $CYAN -Text "> ")
            $nameStyled = (Color -Code "$BOLD;$WHITE" -Text $name)
            $dot = (Color -Code $GRAY -Text "|")
            $summaryText = $engramSummaries[$p.Path]
            if (-not $summaryText) { $summaryText = "(sin summary en Engram para este proyecto)" }
            $summary = (Color -Code $GRAY -Text $summaryText)
            Write-Host "    $bullet$nameStyled  $dot  $summary"
        }
    }
    Write-Host ""

    # PROYECTOS ACTIVOS
    PrintHrTitle -Title "PROYECTOS ACTIVOS  -  ultimos $($cfg.projects.activityWindowDays) dias"
    Write-Host ""
    if ($projects.Count -eq 0) {
        Write-Host "    $(Color -Code $YELLOW -Text 'Sin proyectos con actividad reciente.')"
    } else {
        [int]$idx = 1
        foreach ($p in $projects) {
            if ($p.DaysAgo -eq 0)      { $label = "hoy";  $labelColor = $GREEN }
            elseif ($p.DaysAgo -eq 1)  { $label = "ayer"; $labelColor = $GREEN }
            elseif ($p.DaysAgo -le 3)  { $label = "$($p.DaysAgo)d"; $labelColor = $YELLOW }
            else                       { $label = "$($p.DaysAgo)d"; $labelColor = $GRAY }
            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }
            $num = "{0,2}" -f $idx
            Write-Host ("    " + (Color -Code $CYAN -Text $num) + ". " +
                        (Color -Code "$BOLD;$WHITE" -Text $name) + "  " +
                        (Color -Code $GRAY -Text ("- " + $p.Path)) + "  " +
                        (Color -Code $labelColor -Text "[$label]"))
            $idx++
        }

        [int]$exitLocal = $projects.Count + 1
        Write-Host ""
        Write-Host ("    " + (Color -Code $CYAN -Text ("{0,2}" -f $exitLocal)) + ". " +
                    (Color -Code "$BOLD;$MAG" -Text "Salir") + "  " +
                    (Color -Code $GRAY -Text "- no abrir nada, cerrar esta ventana"))
    }
    Write-Host ""
    PrintHr
    Write-Host ""
}

# -------- No-projects path --------
if ($projects.Count -eq 0) {
    Show-Menu
    Write-Host "    $(Color -Code $GRAY -Text 'Presiona ENTER para cerrar...')"
    Read-Host | Out-Null
    Write-KitLog -Level INFO -Source startup-brief -Message "Closed (no projects)"
    exit 0
}

[int]$exitNum = $projects.Count + 1
Show-Menu

# -------- Prompt loop --------
while ($true) {
    Write-Host -NoNewline ("    " + (Color -Code $BOLD -Text "Que abris hoy?") + " " + (Color -Code $GRAY -Text "[1-$exitNum]") + (Color -Code $CYAN -Text " > "))
    [string]$selection = Read-Host

    if ([string]::IsNullOrWhiteSpace($selection)) {
        Write-Host "    $(Color -Code $GRAY -Text 'Sin seleccion. Cerrando.')"
        Write-KitLog -Level INFO -Source startup-brief -Message "Closed (empty input)"
        Start-Sleep -Seconds 1
        exit 0
    }
    if ($selection -notmatch '^\d+$') {
        Write-Host "    $(Color -Code $RED -Text 'Escribi solo un numero.')"
        continue
    }

    [int]$choice = [int]$selection
    if ($choice -eq $exitNum) {
        Write-Host "    $(Color -Code $GRAY -Text 'Buen laburo hoy!')"
        Write-KitLog -Level INFO -Source startup-brief -Message "Closed (Salir)"
        Start-Sleep -Seconds 1
        exit 0
    }
    if ($choice -lt 1 -or $choice -gt $projects.Count) {
        Write-Host "    $(Color -Code $RED -Text "Numero fuera de rango. Elegi entre 1 y $exitNum.")"
        continue
    }

    $picked = $projects[$choice - 1]
    [string]$pickedName = Split-Path $picked.Path -Leaf
    Write-Host ""
    Write-Host ("    " + (Color -Code $GREEN -Text "> Abriendo") + "  " + (Color -Code $BOLD -Text $pickedName) + "  " + (Color -Code $GRAY -Text "($($picked.Path))"))
    Write-Host ""
    Write-KitLog -Level INFO -Source startup-brief -Message ("Opening project '$pickedName' at $($picked.Path)")

    # Open in a new VS Code window via code.cmd (only path that handles --folder-uri reliably).
    [string]$folderUri = "file:///" + ($picked.Path -replace '\\', '/')
    $cmdArgs = @("--folder-uri", "`"$folderUri`"")
    if ($cfg.vsCode.openInNewWindow) { $cmdArgs = @("--new-window") + $cmdArgs }
    $cmdLine = "code.cmd " + ($cmdArgs -join " ")
    & cmd.exe /c $cmdLine

    # Find VS Code's window by title and minimize it (config-toggleable).
    if ($cfg.vsCode.minimizeAfterLaunch) {
        try {
            [string]$expectedTitle = "$pickedName - Visual Studio Code"
            $vscodeHwnd = [System.IntPtr]::Zero
            for ($i = 0; $i -lt 25; $i++) {
                Start-Sleep -Milliseconds 200
                $vscodeHwnd = [BriefNative.Api]::FindWindow($null, $expectedTitle)
                if ($vscodeHwnd -ne [System.IntPtr]::Zero) { break }
            }
            if ($vscodeHwnd -ne [System.IntPtr]::Zero) {
                [void][BriefNative.Api]::ShowWindow($vscodeHwnd, 6)   # SW_MINIMIZE
                Write-KitLog -Level INFO -Source startup-brief -Message "Minimized VS Code window for '$pickedName'"
            } else {
                Write-KitLog -Level WARN -Source startup-brief -Message "Could not find VS Code window titled '$expectedTitle' to minimize"
            }
        } catch {}
    }

    Show-Menu
}
