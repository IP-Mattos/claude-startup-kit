# Color themes for the startup brief.
# Each theme returns a hashtable with the same keys consumed by the brief.

function Get-StartupKitTheme {
    param([string]$Name = "default")

    $themes = @{
        default = @{
            CYAN   = "38;5;51"
            MAG    = "38;5;207"
            GREEN  = "38;5;42"
            YELLOW = "38;5;220"
            GRAY   = "38;5;245"
            RED    = "38;5;203"
            WHITE  = "38;5;255"
            BOLD   = "1"
        }
        dracula = @{
            CYAN   = "38;5;117"   # cyan-blue
            MAG    = "38;5;141"   # purple
            GREEN  = "38;5;84"    # green
            YELLOW = "38;5;228"   # yellow
            GRAY   = "38;5;240"
            RED    = "38;5;203"
            WHITE  = "38;5;253"
            BOLD   = "1"
        }
        solarized = @{
            CYAN   = "38;5;37"    # solarized cyan
            MAG    = "38;5;125"   # solarized magenta
            GREEN  = "38;5;64"    # solarized green
            YELLOW = "38;5;136"   # solarized yellow
            GRAY   = "38;5;243"
            RED    = "38;5;160"
            WHITE  = "38;5;230"
            BOLD   = "1"
        }
        monochrome = @{
            CYAN   = "37"
            MAG    = "37"
            GREEN  = "37"
            YELLOW = "37"
            GRAY   = "90"
            RED    = "37"
            WHITE  = "97"
            BOLD   = "1"
        }
        nord = @{
            CYAN   = "38;5;110"
            MAG    = "38;5;139"
            GREEN  = "38;5;108"
            YELLOW = "38;5;179"
            GRAY   = "38;5;243"
            RED    = "38;5;131"
            WHITE  = "38;5;253"
            BOLD   = "1"
        }
    }

    if ($themes.ContainsKey($Name.ToLowerInvariant())) {
        return $themes[$Name.ToLowerInvariant()]
    }
    return $themes.default
}
