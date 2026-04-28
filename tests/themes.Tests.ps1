BeforeAll {
    . (Join-Path $PSScriptRoot "..\scripts\lib\themes.ps1")
}

Describe "Get-StartupKitTheme" {
    It "returns the default theme when no name given" {
        $t = Get-StartupKitTheme
        $t.CYAN  | Should -Not -BeNullOrEmpty
        $t.BOLD  | Should -Be "1"
    }

    It "returns the requested theme" {
        $t = Get-StartupKitTheme -Name "dracula"
        $t.CYAN | Should -Be "38;5;117"
        $t.MAG  | Should -Be "38;5;141"
    }

    It "is case-insensitive" {
        $a = Get-StartupKitTheme -Name "DRACULA"
        $b = Get-StartupKitTheme -Name "dracula"
        $a.CYAN | Should -Be $b.CYAN
    }

    It "falls back to default for unknown themes" {
        $unknown = Get-StartupKitTheme -Name "no-such-theme"
        $defaultT = Get-StartupKitTheme -Name "default"
        $unknown.CYAN | Should -Be $defaultT.CYAN
    }

    It "exposes all required color keys for every shipped theme" {
        $required = @("CYAN", "MAG", "GREEN", "YELLOW", "GRAY", "RED", "WHITE", "BOLD")
        foreach ($name in @("default", "dracula", "solarized", "nord", "monochrome")) {
            $t = Get-StartupKitTheme -Name $name
            foreach ($k in $required) {
                $t.ContainsKey($k) | Should -BeTrue -Because "theme '$name' should declare key '$k'"
            }
        }
    }
}
