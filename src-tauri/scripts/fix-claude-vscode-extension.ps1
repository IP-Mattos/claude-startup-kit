# Fix-ClaudeVSCodeExtension
# Patches the recurring Anthropic Claude Code VS Code extension activation bug on Windows
# (hardcoded Linux CI path `file:///home/runner/work/.../sdk.mjs` in extension.js).
#
# Symptom: "command 'claude-vscode.editor.openLast' not found" when clicking the Claude icon.
# See: https://github.com/anthropics/claude-code/issues/28076 (and #28054, #28081, #28410, ...)
#
# Usage:  pwsh -File fix-claude-vscode-extension.ps1
# Re-run safely after every Claude Code extension update if the bug returns.

$ErrorActionPreference = 'Stop'

$badUrl = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/build-agent-sdk/sdk.mjs'

$extRoots = @(
    "$env:USERPROFILE\.vscode\extensions",
    "$env:USERPROFILE\.vscode-insiders\extensions",
    "$env:USERPROFILE\.cursor\extensions",
    "$env:USERPROFILE\.windsurf\extensions"
) | Where-Object { Test-Path $_ }

if (-not $extRoots) {
    Write-Host "No VS Code / Cursor / Windsurf extensions folder found. Nothing to patch." -ForegroundColor Yellow
    exit 0
}

$found = @()
foreach ($root in $extRoots) {
    Get-ChildItem $root -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue | ForEach-Object {
        $found += $_.FullName
    }
}

if (-not $found) {
    Write-Host "No anthropic.claude-code extension installed." -ForegroundColor Yellow
    exit 0
}

$patchedAny = $false
foreach ($extDir in $found) {
    $extJs = Join-Path $extDir 'extension.js'
    if (-not (Test-Path $extJs)) {
        Write-Host "[skip] $extDir - extension.js not found" -ForegroundColor DarkGray
        continue
    }

    $content = [System.IO.File]::ReadAllText($extJs, [System.Text.Encoding]::UTF8)
    $count = ([regex]::Matches($content, [regex]::Escape($badUrl))).Count

    Write-Host "Inspecting: $extJs"
    Write-Host "  Bad URL occurrences: $count"

    if ($count -eq 0) {
        Write-Host "  Already patched (or unaffected version)." -ForegroundColor Green
        continue
    }

    $backup = "$extJs.bak"
    if (-not (Test-Path $backup)) {
        Copy-Item $extJs $backup -Force
        Write-Host "  Backup created: $backup" -ForegroundColor DarkCyan
    } else {
        Write-Host "  Backup already exists, keeping original .bak" -ForegroundColor DarkCyan
    }

    # Build a Windows-safe replacement URL pointing to this extension's own extension.js.
    $goodPath = $extJs -replace '\\', '/'
    if ($goodPath -match '^[A-Za-z]:') {
        $goodPath = $goodPath.Substring(0,1).ToLower() + $goodPath.Substring(1)
    }
    $goodUrl = "file:///$goodPath"

    $patched = $content.Replace($badUrl, $goodUrl)
    [System.IO.File]::WriteAllText($extJs, $patched, [System.Text.Encoding]::UTF8)

    $verify = ([regex]::Matches($patched, [regex]::Escape($badUrl))).Count
    if ($verify -eq 0) {
        Write-Host "  Patched OK - replaced $count occurrence(s) with $goodUrl" -ForegroundColor Green
        $patchedAny = $true
    } else {
        Write-Host "  WARNING: $verify occurrence(s) still present after replace" -ForegroundColor Red
    }
}

if ($patchedAny) {
    Write-Host ""
    Write-Host "Done. Now reload every open VS Code window:" -ForegroundColor Cyan
    Write-Host "  Ctrl+Shift+P -> Developer: Reload Window" -ForegroundColor Cyan
}
