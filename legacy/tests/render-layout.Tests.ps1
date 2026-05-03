BeforeAll {
    . (Join-Path $PSScriptRoot "..\scripts\lib\render-layout.ps1")
}

Describe "Get-VisibleLength" {
    It "returns 0 for empty input" {
        Get-VisibleLength -Text ""    | Should -Be 0
        Get-VisibleLength -Text $null | Should -Be 0
    }

    It "counts plain text correctly" {
        Get-VisibleLength -Text "hello" | Should -Be 5
    }

    It "strips ANSI escape sequences" {
        $esc = [char]27
        $s = "$esc[38;5;51mhello$esc[0m"
        Get-VisibleLength -Text $s | Should -Be 5
    }

    It "handles multiple ANSI sequences in a single string" {
        $esc = [char]27
        $s = "$esc[1;38;5;255mDaily$esc[0m  $esc[38;5;245mBrief$esc[0m"
        Get-VisibleLength -Text $s | Should -Be 12   # "Daily  Brief" = 12 chars
    }
}

Describe "Format-PadRight" {
    It "pads short strings with spaces to reach the requested visible width" {
        $r = Format-PadRight -Text "hi" -Width 5
        $r | Should -Be "hi   "
    }

    It "ignores ANSI when computing visible length" {
        $esc = [char]27
        $coloured = "$esc[1mhi$esc[0m"
        $r = Format-PadRight -Text $coloured -Width 5
        # Visible length of "hi" is 2, so 3 spaces should be appended.
        $r | Should -Be "$($coloured)   "
    }

    It "returns the input unchanged when already at or above width (avoids mid-ANSI truncation)" {
        $r = Format-PadRight -Text "hello" -Width 3
        $r | Should -Be "hello"
    }
}
