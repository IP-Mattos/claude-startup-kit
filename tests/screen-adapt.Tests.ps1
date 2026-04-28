BeforeAll {
    . (Join-Path $PSScriptRoot "..\scripts\lib\screen-adapt.ps1")
}

Describe "Get-AdaptiveDimensions" {
    It "returns sane bounds within configured min/max" {
        $r = Get-AdaptiveDimensions
        $r.Cols     | Should -BeGreaterOrEqual 80
        $r.Cols     | Should -BeLessOrEqual 200
        $r.Lines    | Should -BeGreaterOrEqual 24
        $r.Lines    | Should -BeLessOrEqual 60
        $r.FontSize | Should -BeGreaterOrEqual 12
        $r.FontSize | Should -BeLessOrEqual 28
    }

    It "respects custom MinFont/MaxFont parameters" {
        $r = Get-AdaptiveDimensions -MinFont 16 -MaxFont 18
        $r.FontSize | Should -BeGreaterOrEqual 16
        $r.FontSize | Should -BeLessOrEqual 18
    }

    It "respects custom MinCols/MaxCols parameters" {
        $r = Get-AdaptiveDimensions -MinCols 100 -MaxCols 110
        $r.Cols | Should -BeGreaterOrEqual 100
        $r.Cols | Should -BeLessOrEqual 110
    }

    It "exposes ScreenWidth and ScreenHeight" {
        $r = Get-AdaptiveDimensions
        $r.PSObject.Properties.Name | Should -Contain "ScreenWidth"
        $r.PSObject.Properties.Name | Should -Contain "ScreenHeight"
        $r.ScreenWidth  | Should -BeGreaterThan 0
        $r.ScreenHeight | Should -BeGreaterThan 0
    }
}
