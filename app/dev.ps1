Set-Location $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsInstall) {
        $vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $vcvars) {
            $envOutput = & cmd.exe /c "`"$vcvars`" && set"
            $envOutput | ForEach-Object {
                if ($_ -match '^([^=]+)=(.*)$') {
                    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] -ErrorAction SilentlyContinue
                }
            }
        }
    }
}
Get-Process app -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
pnpm tauri dev
