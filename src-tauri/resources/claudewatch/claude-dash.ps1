# Opens Claude Code + claudewatch side by side in one Windows Terminal window.
# Claude takes the left pane; claudewatch the right (~30%).
#
#   claude-dash.ps1                       # Claude in your home dir
#   claude-dash.ps1 -Path C:\proj\foo     # Claude opened in that project folder
#   claude-dash.ps1 -Scheme Dracula       # pick a color scheme
param(
    [string]$Scheme = 'Andromeda',
    [string]$Path = ''
)

$dash = Join-Path $PSScriptRoot 'claudewatch.exe'

# Build the wt argument list as an array so the pane-delimiter ';' is passed
# as its own literal argument (no fragile backtick/cmd escaping).
$wtArgs = @('new-tab', '--colorScheme', $Scheme, '--title', 'Claude')
if ($Path) { $wtArgs += @('--startingDirectory', $Path) }
$wtArgs += @('cmd', '/k', 'claude')

$wtArgs += ';'

$wtArgs += @('split-pane', '--vertical', '--size', '0.26', '--colorScheme', $Scheme, '--title', 'claudewatch')
$wtArgs += @('cmd', '/k', $dash)

# Hand focus back to the Claude pane so you can start typing immediately.
$wtArgs += ';'
$wtArgs += @('move-focus', 'left')

& wt.exe @wtArgs
