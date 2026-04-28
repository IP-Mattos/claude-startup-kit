# Tiny rendering helpers used by startup-brief.ps1.
# After the v1.3.0 redesign, only two helpers are still needed.

$script:RL_ESC = [char]27

# Strip ANSI escape sequences to count visible character cells.
function Get-VisibleLength {
    param([string]$Text)
    if (-not $Text) { return 0 }
    $clean = $Text -replace "$script:RL_ESC\[[0-9;]*m", ""
    return $clean.Length
}

# Pad an ANSI-laden string with spaces so its VISIBLE length equals $Width.
function Format-PadRight {
    param([string]$Text, [int]$Width)
    [int]$visible = Get-VisibleLength -Text $Text
    [int]$pad = $Width - $visible
    if ($pad -lt 0) {
        # Truncating mid-ANSI is risky — return the original string instead.
        return $Text
    }
    return $Text + (' ' * $pad)
}
