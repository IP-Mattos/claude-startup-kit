# Claude Code Daily Brief — runs at Windows login
# Interactive: after opening a project, the menu returns so you can open more.

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
[Console]::InputEncoding  = $utf8NoBom

$Host.UI.RawUI.WindowTitle = "Claude Code  |  Daily Brief"

# -------- Consolidated Native API imports (one Add-Type = one compile) --------
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

# Font bump (Consolas 14px)
try {
    $h = [BriefNative.Api]::GetStdHandle(-11)
    $cfi = New-Object BriefNative.Api+CONSOLE_FONT_INFOEX
    $cfi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($cfi)
    $cfi.nFont = 0
    $coord = New-Object BriefNative.Api+COORD
    $coord.X = 0; $coord.Y = 14
    $cfi.dwFontSize = $coord
    $cfi.FontFamily = 54
    $cfi.FontWeight = 400
    $cfi.FaceName = "Consolas"
    [void][BriefNative.Api]::SetCurrentConsoleFontEx($h, $false, [ref]$cfi)
} catch {}

# Restore + center + TOPMOST (without stealing focus)
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $hWnd = [BriefNative.Api]::GetConsoleWindow()
    if ($hWnd -ne [System.IntPtr]::Zero) {
        [void][BriefNative.Api]::ShowWindow($hWnd, 4)   # SW_SHOWNOACTIVATE

        # Center on the primary screen's working area
        $rect = New-Object BriefNative.Api+RECT
        [void][BriefNative.Api]::GetWindowRect($hWnd, [ref]$rect)
        $winW = $rect.Right - $rect.Left
        $winH = $rect.Bottom - $rect.Top
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $x = [int](($screen.Width  - $winW) / 2) + $screen.X
        $y = [int](($screen.Height - $winH) / 2) + $screen.Y
        [void][BriefNative.Api]::MoveWindow($hWnd, $x, $y, $winW, $winH, $true)

        # Always-on-top
        [System.IntPtr]$HWND_TOPMOST = [System.IntPtr]::new(-1)
        [uint32]$flags = 0x0001 -bor 0x0002 -bor 0x0010   # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
        [void][BriefNative.Api]::SetWindowPos($hWnd, $HWND_TOPMOST, 0, 0, 0, 0, $flags)
    }
} catch {}

# -------- Width detection --------
[int]$W = 100
try {
    [int]$detected = [Console]::WindowWidth
    if ($detected -ge 60) { $W = $detected - 2 }
} catch {}

# -------- Colors --------
$ESC = [char]27
function Color {
    param([string]$Code, [string]$Text)
    return "$ESC[${Code}m$Text$ESC[0m"
}

$CYAN   = "38;5;51"
$MAG    = "38;5;207"
$GREEN  = "38;5;42"
$YELLOW = "38;5;220"
$GRAY   = "38;5;245"
$RED    = "38;5;203"
$WHITE  = "38;5;255"
$BOLD   = "1"

# -------- Render helpers --------
function HLine {
    param([int]$Length)
    if ($Length -lt 1) { return "" }
    return ([string]([char]0x2550)) * $Length
}

function PrintHr {
    [Console]::WriteLine("  " + (Color -Code $CYAN -Text (HLine -Length $W)))
}

function PrintHrTitle {
    param([string]$Title)
    [string]$prefix = (HLine -Length 4) + " "
    [int]$used = $prefix.Length + $Title.Length + 1
    [int]$rest = $W - $used
    if ($rest -lt 4) { $rest = 4 }
    [string]$line = $prefix + $Title + " " + (HLine -Length $rest)
    [Console]::WriteLine("  " + (Color -Code $CYAN -Text $line))
}

# -------- Scan projects via Python (once) --------
$pythonScript = @'
import json, os, sys, time
from pathlib import Path

home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
projects_dir = home / ".claude" / "projects"
if not projects_dir.is_dir():
    sys.exit(0)

now = time.time()
cutoff = now - 14 * 86400
entries = []

for pdir in projects_dir.iterdir():
    if not pdir.is_dir():
        continue

    jsonls = sorted(pdir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not jsonls:
        continue

    # Use newest JSONL mtime (NTFS doesn't update folder mtime on file modification).
    try:
        mtime = jsonls[0].stat().st_mtime
    except OSError:
        continue
    if mtime < cutoff:
        continue

    cwd = None
    for jpath in jsonls:
        try:
            with jpath.open("r", encoding="utf-8") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and obj.get("cwd"):
                        cwd = obj["cwd"]
                        break
            if cwd:
                break
        except OSError:
            continue

    if not cwd:
        continue

    # Skip projects whose folder no longer exists on disk.
    if not Path(cwd).is_dir():
        continue

    days_ago = int((now - mtime) // 86400)
    last_date = time.strftime("%Y-%m-%d", time.localtime(mtime))
    entries.append((mtime, days_ago, last_date, cwd))

entries.sort(key=lambda e: e[0], reverse=True)
for _, days_ago, last_date, cwd in entries:
    print(f"{days_ago}|{last_date}|{cwd}")
'@

$raw = $pythonScript | & python -

$projects = @()
foreach ($line in $raw) {
    $parts = $line -split '\|', 3
    if ($parts.Count -eq 3) {
        $projects += [PSCustomObject]@{
            DaysAgo  = [int]$parts[0]
            LastDate = $parts[1]
            Path     = $parts[2]
        }
    }
}

# -------- gentle-ai version check (once) --------
[string]$lastSeenFile = "$env:USERPROFILE\.claude\scripts\.gentle-ai-last-seen-version"
[string]$currentVersion = ""
try {
    $verOutput = & gentle-ai version 2>$null
    if ($verOutput -is [array]) { $verOutput = ($verOutput -join "`n") }
    if ($verOutput -match '(\d+\.\d+\.\d+)') {
        $currentVersion = $matches[1]
    }
} catch {}

[string]$lastSeen = ""
if (Test-Path $lastSeenFile) {
    try { $lastSeen = (Get-Content $lastSeenFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
}

if (-not [string]::IsNullOrWhiteSpace($currentVersion)) {
    try { $currentVersion | Out-File -FilePath $lastSeenFile -Encoding ascii -NoNewline -ErrorAction SilentlyContinue } catch {}
}

# -------- Render function --------
function Show-Menu {
    Clear-Host
    Write-Host ""

    # Banner
    PrintHr
    Write-Host ""
    [string]$bannerInner = (Color -Code "$BOLD;$MAG" -Text ">>  CLAUDE CODE") + "   " + (Color -Code $GRAY -Text "|") + "   " + (Color -Code "$BOLD;$CYAN" -Text "DAILY BRIEF")
    Write-Host "    $bannerInner"
    Write-Host ""
    PrintHr
    Write-Host ""

    # Date
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

    # AYER EN RESUMEN
    PrintHrTitle -Title "AYER EN RESUMEN"
    Write-Host ""
    $recentProjects = @($projects | Where-Object { $_.DaysAgo -le 2 })
    if ($recentProjects.Count -eq 0) {
        Write-Host "    $(Color -Code $GRAY -Text 'Sin actividad en las ultimas 48h.')"
    } else {
        foreach ($p in $recentProjects) {
            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }
            [string]$bullet = (Color -Code $CYAN -Text "> ")
            [string]$nameStyled = (Color -Code "$BOLD;$WHITE" -Text $name)
            [string]$dot = (Color -Code $GRAY -Text "|")
            [string]$summary = (Color -Code $GRAY -Text "(historial Engram - se enriquece dia a dia)")
            Write-Host "    $bullet$nameStyled  $dot  $summary"
        }
    }
    Write-Host ""

    # PROYECTOS ACTIVOS
    PrintHrTitle -Title "PROYECTOS ACTIVOS  -  ultimos 14 dias"
    Write-Host ""
    if ($projects.Count -eq 0) {
        Write-Host "    $(Color -Code $YELLOW -Text 'Sin proyectos con actividad en los ultimos 14 dias.')"
    } else {
        [int]$idx = 1
        foreach ($p in $projects) {
            if ($p.DaysAgo -eq 0)      { $label = "hoy";  $labelColor = $GREEN }
            elseif ($p.DaysAgo -eq 1)  { $label = "ayer"; $labelColor = $GREEN }
            elseif ($p.DaysAgo -le 3)  { $label = "$($p.DaysAgo)d"; $labelColor = $YELLOW }
            else                       { $label = "$($p.DaysAgo)d"; $labelColor = $GRAY }

            [string]$name = Split-Path $p.Path -Leaf
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $p.Path }

            [string]$num = "{0,2}" -f $idx
            [string]$numC = (Color -Code $CYAN -Text $num)
            [string]$nameC = (Color -Code "$BOLD;$WHITE" -Text $name)
            [string]$pathC = (Color -Code $GRAY -Text ("- " + $p.Path))
            [string]$labelC = (Color -Code $labelColor -Text "[$label]")

            Write-Host "    $numC. $nameC  $pathC  $labelC"
            $idx++
        }

        [int]$exitLocal = $projects.Count + 1
        Write-Host ""
        [string]$numExit = "{0,2}" -f $exitLocal
        [string]$numExitC = (Color -Code $CYAN -Text $numExit)
        [string]$exitC = (Color -Code "$BOLD;$MAG" -Text "Salir")
        [string]$exitDescC = (Color -Code $GRAY -Text "- no abrir nada, cerrar esta ventana")
        Write-Host "    $numExitC. $exitC  $exitDescC"
    }

    Write-Host ""
    PrintHr
    Write-Host ""
}

# -------- Handle no-projects case --------
if ($projects.Count -eq 0) {
    Show-Menu
    Write-Host "    $(Color -Code $GRAY -Text 'Presiona ENTER para cerrar...')"
    Read-Host | Out-Null
    exit 0
}

[int]$exitNum = $projects.Count + 1

# -------- Initial render --------
Show-Menu

# -------- Prompt loop (re-renders menu after each project opened) --------
while ($true) {
    Write-Host -NoNewline ("    " + (Color -Code $BOLD -Text "Que abris hoy?") + " " + (Color -Code $GRAY -Text "[1-$exitNum]") + (Color -Code $CYAN -Text " > "))
    [string]$selection = Read-Host

    if ([string]::IsNullOrWhiteSpace($selection)) {
        Write-Host "    $(Color -Code $GRAY -Text 'Sin seleccion. Cerrando.')"
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

    # Open folder in a NEW VS Code window via code.cmd (only path that handles --folder-uri).
    [string]$folderUri = "file:///" + ($picked.Path -replace '\\', '/')
    & cmd.exe /c "code.cmd --new-window --folder-uri `"$folderUri`""

    # Find VS Code's window by title and minimize it so it doesn't cover the screen.
    # Brief stays visible on top because it's TOPMOST (set at script start).
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
        }
    } catch {}

    # Re-render the menu so you can pick another project.
    Show-Menu
}
