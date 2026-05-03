# Changelog

## 0.1.2 — 2026-05-03

### Added
- **Real auto-updater** — the in-app "Update available" banner now actually updates the app: download the new bundle → verify Ed25519 signature against the embedded public key → atomically replace the binary → restart. Previously the "Apply" button just opened the GitHub Release page for manual download. Implemented with `tauri-plugin-updater` against a `latest.json` manifest published by the release workflow. New backend command `apply_app_update`; new hook fields `applyApp` / `applyingApp` on `useUpdates`.

### Release pipeline
- **Signed bundles** — `release.yml` now uses `tauri-apps/tauri-action@v0`, which signs every `.msi` / `-setup.exe` with the updater private key (stored in GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD}`) and emits `latest.json` alongside the artifacts. The legacy hand-rolled bundle/upload script is gone.

### Notes
- The first build that ships with the auto-updater is **this one (v0.1.2)**. Users who installed v0.1.0 or v0.1.1 do **not** have the updater plugin embedded yet, so they still need to download v0.1.2 manually one last time. From v0.1.2 onward, the cycle is hands-off.

## 0.1.1 — 2026-05-03

### Fixed
- **No more cmd flicker on tab navigation** — every CLI subprocess (`gh`, `git`, `engram`, `powershell`, `gentle-ai`, `rundll32`, `code.cmd`, `explorer`) was spawned without `CREATE_NO_WINDOW`, so each call attached a `conhost.exe` window that flashed visibly on every tab change. Added a `silent_command(program: &str) -> Command` helper that applies the flag on Windows and is a transparent no-op on other targets, then routed all 22 callsites through it. ([#1](https://github.com/IP-Mattos/claude-startup-kit/pull/1))

### Release pipeline
- **`release.yml` workflow** — builds and publishes Windows installers (`.msi` + `.exe`) automatically on every `v*` tag push. Replaces the manual MSI upload that shipped v0.1.0.

## 0.1.0 — 2026-05-03

First installable release of the Tauri desktop app. See the [v0.1.0 release notes](https://github.com/IP-Mattos/claude-startup-kit/releases/tag/v0.1.0) for the full feature list (9 tabs, 8 themes, bilingual UI, workspace sync, update channel).
