BeforeAll {
    $libPath = Join-Path $PSScriptRoot "..\scripts\lib\config.ps1"
    . $libPath
    $script:tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("kit-test-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $script:tmpDir -Force | Out-Null
}

AfterAll {
    if (Test-Path $script:tmpDir) { Remove-Item $script:tmpDir -Recurse -Force }
}

Describe "Get-StartupKitConfig" {
    It "returns defaults when no user config exists" {
        $cfg = Get-StartupKitConfig -ConfigDir $script:tmpDir
        $cfg.theme | Should -Be "default"
        $cfg.window.cols | Should -Be 120
        $cfg.window.adaptive | Should -Be $true
        $cfg.projects.activityWindowDays | Should -Be 14
        $cfg.engram.fetchSummariesForBrief | Should -Be $true
    }

    It "merges user values over defaults" {
        $userCfg = @{ theme = "dracula"; window = @{ cols = 99; lines = 40 } } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:tmpDir "startup-kit-config.json") -Value $userCfg -Encoding utf8
        $cfg = Get-StartupKitConfig -ConfigDir $script:tmpDir
        $cfg.theme | Should -Be "dracula"
        $cfg.window.cols | Should -Be 99
        $cfg.window.lines | Should -Be 40
        # Untouched fields should still come from defaults
        $cfg.window.fontName | Should -Be "Consolas"
        $cfg.projects.activityWindowDays | Should -Be 14
    }

    It "skips keys starting with underscore (documentation keys)" {
        $userCfg = @{ window = @{ "_cols_help" = "should be ignored"; cols = 88 } } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:tmpDir "startup-kit-config.json") -Value $userCfg -Encoding utf8
        { Get-StartupKitConfig -ConfigDir $script:tmpDir } | Should -Not -Throw
        $cfg = Get-StartupKitConfig -ConfigDir $script:tmpDir
        $cfg.window.cols | Should -Be 88
    }

    It "ignores unknown keys silently" {
        $userCfg = @{ window = @{ unknownProp = "x"; cols = 77 } } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:tmpDir "startup-kit-config.json") -Value $userCfg -Encoding utf8
        { Get-StartupKitConfig -ConfigDir $script:tmpDir } | Should -Not -Throw
        $cfg = Get-StartupKitConfig -ConfigDir $script:tmpDir
        $cfg.window.cols | Should -Be 77
    }

    It "falls back to defaults if user config is invalid JSON" {
        Set-Content -Path (Join-Path $script:tmpDir "startup-kit-config.json") -Value "{ this is not json" -Encoding utf8
        $cfg = Get-StartupKitConfig -ConfigDir $script:tmpDir
        $cfg.theme | Should -Be "default"
    }
}
