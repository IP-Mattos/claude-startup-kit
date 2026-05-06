# Local Tauri build helper.
#
# Mirrors `dev.ps1`'s vcvars64 bootstrap (so cargo finds link.exe), then
# runs `pnpm tauri build` to produce a Windows .msi + .exe under
# `src-tauri/target/release/bundle/`. Skips the auto-updater signing step
# because the signing key lives in GH Actions secrets, not on disk —
# `createUpdaterArtifacts` will warn but the regular installer bundle
# still produces and is install-clickable.
#
# Why this script exists: GH Actions billing got paused mid-session.
# This is the manual escape hatch — build locally, install the .msi by
# hand, get the new themes (or whatever feature) without going through
# the release pipeline.

Set-Location $PSScriptRoot

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vswhereDir = Split-Path $vswhere -Parent
    if (-not ($env:PATH -split ';' -contains $vswhereDir)) {
        $env:PATH = "$vswhereDir;$env:PATH"
    }
    $vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsInstall) {
        $vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $vcvars) {
            Write-Host "Bootstrapping MSVC env from: $vcvars" -ForegroundColor Cyan
            $envOutput = & cmd.exe /c "`"$vcvars`" && set"
            $envOutput | ForEach-Object {
                if ($_ -match '^([^=]+)=(.*)$') {
                    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

Write-Host "Killing any running CSK instance..." -ForegroundColor Cyan
Get-Process app -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process "Claude Startup Kit" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Make sure `pnpm` is callable from any subprocess Tauri spawns
# (especially `beforeBuildCommand: pnpm build` in tauri.conf.json).
# corepack's shim dir is the canonical location. We don't enable
# globally — just inject for this build's lifetime.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
        Write-Host "Neither pnpm nor corepack found in PATH. Install Node.js (>=16)." -ForegroundColor Red
        exit 1
    }
    Write-Host "Activating corepack pnpm for this session..." -ForegroundColor Cyan
    & corepack enable pnpm 2>&1 | Out-Null
    # corepack drops shims into Node's bin dir.
    $nodeBin = Split-Path (Get-Command node).Source -Parent
    if (-not ($env:PATH -split ';' -contains $nodeBin)) {
        $env:PATH = "$nodeBin;$env:PATH"
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        # Fallback: create a one-shot pnpm.cmd in a temp dir on PATH.
        $shimDir = Join-Path $env:TEMP "csk-build-shim"
        New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
        $shimPath = Join-Path $shimDir "pnpm.cmd"
        '@echo off' | Out-File -FilePath $shimPath -Encoding ASCII
        '@corepack pnpm %*' | Out-File -FilePath $shimPath -Encoding ASCII -Append
        $env:PATH = "$shimDir;$env:PATH"
        Write-Host "  Wrote shim at $shimPath" -ForegroundColor Cyan
    }
}

# Strip ONLY the GNU coreutils dirs that ship with Git for Windows
# (`Git\usr\bin` is the worst offender — it has its own `link.exe`
# that conflicts with MSVC's). DO NOT strip generic `Git\bin` because
# vcvars64's MSVC paths can sometimes be confused with it on substring
# match. Surgical removal only.
$pathBefore = $env:PATH
$badGnuDirs = @(
    "Git\usr\bin",
    "Git\mingw64\bin"
)
$filtered = ($env:PATH -split ';' | Where-Object {
    $p = $_
    -not ($badGnuDirs | Where-Object { $p -like "*$_*" })
}) -join ';'
if ($filtered -ne $env:PATH) {
    Write-Host "Stripped GNU coreutils paths so MSVC link.exe wins" -ForegroundColor Cyan
    $env:PATH = $filtered
}

# Diagnostic: which link.exe will Rust find?
$resolvedLink = (Get-Command link.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ($resolvedLink) {
    Write-Host "link.exe resolves to: $resolvedLink" -ForegroundColor Cyan
} else {
    Write-Host "WARNING: link.exe not found in PATH after vcvars + strip" -ForegroundColor Yellow
}

Write-Host "`nRunning: pnpm tauri build`n" -ForegroundColor Green
pnpm tauri build
$exit = $LASTEXITCODE
$env:PATH = $pathBefore  # restore

if ($exit -eq 0) {
    Write-Host "`n✓ Build OK. Bundle output:`n" -ForegroundColor Green
    Get-ChildItem -Recurse -Path "src-tauri\target\release\bundle" -Include *.msi,*.exe -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "  $($_.FullName)" }
    Write-Host "`nDouble-click the .msi to install. The unsigned bundle won't trigger auto-update — install once by hand and future signed releases will resume normal upgrades." -ForegroundColor Yellow
} else {
    Write-Host "`n✗ Build failed with exit code $exit" -ForegroundColor Red
}

exit $exit
