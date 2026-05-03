# Changelog

## 0.1.1 — 2026-05-03

### Fixed
- **No more cmd flicker on tab navigation** — every CLI subprocess (`gh`, `git`, `engram`, `powershell`, `gentle-ai`, `rundll32`, `code.cmd`, `explorer`) was spawned without `CREATE_NO_WINDOW`, so each call attached a `conhost.exe` window that flashed visibly on every tab change. Added a `silent_command(program: &str) -> Command` helper that applies the flag on Windows and is a transparent no-op on other targets, then routed all 22 callsites through it. ([#1](https://github.com/IP-Mattos/claude-startup-kit/pull/1))

### Release pipeline
- **`release.yml` workflow** — builds and publishes Windows installers (`.msi` + `.exe`) automatically on every `v*` tag push. Replaces the manual MSI upload that shipped v0.1.0.

## 0.1.0 — 2026-05-03

First installable release of the Tauri desktop app. See the [v0.1.0 release notes](https://github.com/IP-Mattos/claude-startup-kit/releases/tag/v0.1.0) for the full feature list (9 tabs, 8 themes, bilingual UI, workspace sync, update channel).
