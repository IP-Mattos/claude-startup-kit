# Opens Claude Code + claudewatch for a project.
#
#   claude-dash.ps1 -Path C:\proj\foo   # scope Claude to a project folder
#   claude-dash.ps1 -Scheme Dracula     # Windows Terminal color scheme
#
# If Windows Terminal (wt.exe) is available, both run side by side in one window
# (Claude left, claudewatch right). If it ISN'T installed — so this works on ANY
# Windows PC — it falls back to two plain console windows. The fallback windows
# are visible (not hidden), so if a sub-tool like `claude` is missing you SEE the
# error instead of nothing happening.
param(
    [string]$Scheme = 'Andromeda',
    [string]$Path = ''
)

$dash = Join-Path $PSScriptRoot 'claudewatch.exe'

# Resolve Windows Terminal: PATH first, then the WindowsApps execution alias
# (which may be off PATH if app-execution-aliases are disabled).
$wt = (Get-Command wt.exe -ErrorAction SilentlyContinue).Source
if (-not $wt) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
    if (Test-Path $alias) { $wt = $alias }
}

if ($wt) {
    # Windows Terminal available: the nice split (Claude | claudewatch).
    $wtArgs = @('new-tab', '--colorScheme', $Scheme, '--title', 'Claude')
    if ($Path) { $wtArgs += @('--startingDirectory', $Path) }
    $wtArgs += @('cmd', '/k', 'claude')
    $wtArgs += ';'
    $wtArgs += @('split-pane', '--vertical', '--size', '0.26', '--colorScheme', $Scheme, '--title', 'claudewatch')
    if ($Path) { $wtArgs += @('--startingDirectory', $Path) }
    $wtArgs += @('cmd', '/k', $dash)
    if ($Path) { $wtArgs += '--focus-cwd' }   # lock the dashboard to this project's session
    $wtArgs += ';'
    $wtArgs += @('move-focus', 'left')   # focus the Claude pane so you can type
    & $wt @wtArgs
}
else {
    # No Windows Terminal: fall back to two plain windows so it works anywhere.
    if ($Path) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'claude' -WorkingDirectory $Path | Out-Null
    }
    else {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'claude' | Out-Null
    }
    if ($Path) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "`"$dash`" --focus-cwd" -WorkingDirectory $Path | Out-Null
    }
    else {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "`"$dash`"" | Out-Null
    }
}
