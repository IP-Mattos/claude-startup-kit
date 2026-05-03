# Adaptive sizing — calculates window dimensions and font size based on
# the primary monitor's working area (excludes taskbar). Tunable via the
# config; if `window.adaptive` is false, the config's literal cols/lines/fontSize
# are used instead.

function Get-AdaptiveDimensions {
    [CmdletBinding()]
    param(
        [double]$WidthRatio = 0.55,    # window will aim for this fraction of screen width
        [double]$HeightRatio = 0.55,   # ...and this of screen height
        [int]$MinCols = 80, [int]$MaxCols = 200,
        [int]$MinLines = 24, [int]$MaxLines = 60,
        [int]$MinFont = 12, [int]$MaxFont = 28
    )

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $widthPx = [int]$screen.Width
    $heightPx = [int]$screen.Height

    # Font size proportional to screen width: roughly 1px per 130px of screen width.
    # Tweaked to land sensibly on 1366 / 1920 / 2560 / 3840 monitors.
    [int]$fontSize = [int][math]::Round($widthPx / 130.0)
    if ($fontSize -lt $MinFont) { $fontSize = $MinFont }
    if ($fontSize -gt $MaxFont) { $fontSize = $MaxFont }

    # Approximate Consolas character cell metrics in pixels.
    $charW = [double]$fontSize * 0.55
    $charH = [double]$fontSize * 1.15

    $targetWPx = $widthPx * $WidthRatio
    $targetHPx = $heightPx * $HeightRatio

    [int]$cols  = [int][math]::Floor($targetWPx / $charW)
    [int]$lines = [int][math]::Floor($targetHPx / $charH)

    if ($cols -lt $MinCols) { $cols = $MinCols }
    if ($cols -gt $MaxCols) { $cols = $MaxCols }
    if ($lines -lt $MinLines) { $lines = $MinLines }
    if ($lines -gt $MaxLines) { $lines = $MaxLines }

    return [PSCustomObject]@{
        Cols         = $cols
        Lines        = $lines
        FontSize     = $fontSize
        ScreenWidth  = $widthPx
        ScreenHeight = $heightPx
    }
}
