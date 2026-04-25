# Render helpers for the dashboard layout: bordered cards, side-by-side columns,
# stat tiles. Functions return arrays of pre-rendered ANSI lines that the caller
# concatenates and writes — keeps the renderer composable and easier to debug.

# Generate a deterministic 5-7 char NODE code from a project name.
# Example: "PolyMarket" -> "POL-MKT", "SanoYRico" -> "SAN-YRI"
function New-NodeCode {
    param([Parameter(Mandatory=$true)][string]$Name)
    $clean = ($Name -replace '[^A-Za-z0-9]', '').ToUpperInvariant()
    if ($clean.Length -eq 0) { return "NODE-?" }
    if ($clean.Length -le 6) { return $clean }
    $left  = $clean.Substring(0, 3)
    $right = if ($clean.Length -ge 6) { $clean.Substring($clean.Length - 3, 3) } else { $clean.Substring(3) }
    return "$left-$right"
}

# Short session ID — 4 hex chars based on the current second.
function New-SessionId {
    $bytes = [Guid]::NewGuid().ToByteArray()
    $hex = ($bytes[0..1] | ForEach-Object { $_.ToString("X2") }) -join ""
    return $hex
}

$script:RL_ESC = [char]27
function _RL_Color { param([string]$Code, [string]$Text) return "$script:RL_ESC[${Code}m$Text$script:RL_ESC[0m" }

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
        # Truncate is risky with ANSI mid-sequence — instead, just return the original.
        return $Text
    }
    return $Text + (' ' * $pad)
}

# Draw a card with rounded corners. Returns an array of rendered lines.
function New-Card {
    param(
        [Parameter(Mandatory=$true)][string]$Title,
        [string[]]$Lines = @(),
        [Parameter(Mandatory=$true)][int]$Width,
        [string]$BorderColor = "38;5;245",
        [string]$TitleColor  = "1;38;5;51"
    )

    if ($Width -lt 12) { $Width = 12 }
    $titleStyled = (_RL_Color -Code $TitleColor -Text $Title)
    $titleVisible = $Title.Length

    # Top: ╭─ TITLE ─...─╮
    $tl = ([char]0x256D); $tr = ([char]0x256E)
    $bl = ([char]0x2570); $br = ([char]0x256F)
    $h  = ([char]0x2500); $v  = ([char]0x2502)

    # title takes "─ TITLE ─" with one ─ on each side at minimum
    [int]$titleSegment = $titleVisible + 4    # "─ TITLE ─"
    [int]$rightFill = $Width - 1 - $titleSegment - 1
    if ($rightFill -lt 1) { $rightFill = 1 }

    $topLine = (_RL_Color -Code $BorderColor -Text "$tl$h ") + $titleStyled + (_RL_Color -Code $BorderColor -Text " $($h.ToString() * $rightFill)$tr")
    $botLine = (_RL_Color -Code $BorderColor -Text "$bl$($h.ToString() * ($Width - 2))$br")

    $rendered = @($topLine)
    $innerWidth = $Width - 4   # 2 borders + 2 padding spaces
    foreach ($line in $Lines) {
        # Pad the inner content to innerWidth (visible)
        $padded = Format-PadRight -Text $line -Width $innerWidth
        $row = (_RL_Color -Code $BorderColor -Text "$v ") + $padded + (_RL_Color -Code $BorderColor -Text " $v")
        $rendered += $row
    }
    $rendered += $botLine
    return $rendered
}

# Render two arrays of pre-rendered lines side by side. Pads the shorter one with
# blank lines so they align. Joined with $Gap spaces between.
function Format-SideBySide {
    param(
        [string[]]$Left,
        [string[]]$Right,
        [int]$LeftWidth,
        [int]$RightWidth,
        [int]$Gap = 2,
        [int]$Indent = 2
    )

    $maxLines = [math]::Max($Left.Count, $Right.Count)
    $output = New-Object System.Collections.Generic.List[string]
    $indentStr = (' ' * $Indent)
    $gapStr = (' ' * $Gap)

    for ($i = 0; $i -lt $maxLines; $i++) {
        $l = if ($i -lt $Left.Count)  { $Left[$i]  } else { "" }
        $r = if ($i -lt $Right.Count) { $Right[$i] } else { "" }
        $lPad = Format-PadRight -Text $l -Width $LeftWidth
        $rPad = Format-PadRight -Text $r -Width $RightWidth
        $output.Add($indentStr + $lPad + $gapStr + $rPad)
    }
    return $output.ToArray()
}

# A single-line stat tile: [icon  label    value]
function New-StatTile {
    param(
        [Parameter(Mandatory=$true)][string]$Icon,
        [Parameter(Mandatory=$true)][string]$Label,
        [Parameter(Mandatory=$true)][string]$Value,
        [int]$Width = 30,
        [string]$IconColor   = "38;5;51",
        [string]$LabelColor  = "38;5;245",
        [string]$ValueColor  = "1;38;5;255",
        [string]$BorderColor = "38;5;240"
    )

    $h  = ([char]0x2500); $v = ([char]0x2502)
    $tl = ([char]0x256D); $tr = ([char]0x256E); $bl = ([char]0x2570); $br = ([char]0x256F)

    $top = (_RL_Color -Code $BorderColor -Text "$tl$($h.ToString() * ($Width - 2))$tr")
    $bot = (_RL_Color -Code $BorderColor -Text "$bl$($h.ToString() * ($Width - 2))$br")

    $iconStyled  = (_RL_Color -Code $IconColor  -Text $Icon)
    $labelStyled = (_RL_Color -Code $LabelColor -Text $Label)
    $valueStyled = (_RL_Color -Code $ValueColor -Text $Value)
    $body = "$iconStyled  $labelStyled  $valueStyled"
    $padded = Format-PadRight -Text $body -Width ($Width - 4)
    $mid = (_RL_Color -Code $BorderColor -Text "$v ") + $padded + (_RL_Color -Code $BorderColor -Text " $v")

    return @($top, $mid, $bot)
}
