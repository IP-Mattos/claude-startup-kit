# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Windows desktop app — Claude Code companion built on **Tauri 2 + React 19 + Vite**. The app lives at the repository root.

The original PowerShell installer + scripts (`install.ps1`, `scripts/`, `tests/`, `claude-templates/`) has been retired to [`legacy/`](legacy/). It is no longer the shipping product. The Tauri app shells out to `~/.claude/scripts/claude-audit.ps1` when present, but that file is now considered a legacy interop point — the long-term plan is to bring the audit logic into the Rust side.

Treat `legacy/` as read-only archive. Don't refactor across the boundary.

## Commands

### Development
- `pnpm dev` — Vite-only (browser preview at `http://localhost:1420`, no Tauri shell)
- `pnpm tauri dev` — full desktop app. **On Windows use `./dev.ps1`** — it bootstraps MSVC `vcvars64` so `cargo` finds `link.exe`, kills any prior dev instance, then runs `pnpm tauri dev`.
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — `tsc && vite build` (frontend only). **Never run unless asked** (per global rule).

### Legacy (only if asked to touch the shell kit)
- `legacy/install.ps1 [-DryRun] [-Force]` — installs the old shell kit into `~/.claude/`.
- `Invoke-Pester -Path legacy/tests/` — Pester tests for the old PowerShell libs.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs frontend typecheck, `cargo check` against `src-tauri/`, and a legacy PowerShell parse pass.

## Architecture

Tauri 2 with a tray-icon-only lifecycle: `CloseRequested` hides the window instead of exiting; tray left-click brings it back. Single window registered in `tauri.conf.json` as `"main"`.

**Rust commands** ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) are the API surface invoked from React via `@tauri-apps/api/core`'s `invoke()`. Conventions:

- **Blocking IO is wrapped in `tokio::task::spawn_blocking`** — every `scan_*`, `enrich_*`, `run_audit`, `github_review_queue`, plus the recently-converted `open_in_vscode`, `open_path_in_explorer`, `cleanup_apply`, `git_last_commit`, `engram_project_goal`. Don't add new commands that block on the async runtime.
- **Path confinement for destructive ops**: `cleanup_apply` canonicalizes both the candidate path AND the allowed roots (`~/.claude/{logs,backups,projects}`), then `starts_with`-checks. Symlinks are refused outright (via `symlink_metadata`).
- **`validate_open_path()`** is the gate for any IPC that opens or executes against a user-supplied path. It rejects: empty strings, leading `-` (looks like a flag), leading `/` (Unix-style on Windows), `shell:` / `file://` / `ms-windows-store:` / `::{` protocol prefixes, UNC paths (`\\server\share`), non-existent paths. New IPC that touches the FS must call it first.
- **`\\?\` UNC prefix is stripped** after `fs::canonicalize` on Windows so paths round-trip cleanly through IPC and back into git/explorer.
- **External CLIs** (`gh`, `engram`, `git`, `code.cmd`, `powershell`, `rundll32`) are shelled out via `Command`. Never use `cmd.exe /c` for URLs (the `&` in PR query strings becomes a command separator) — use `rundll32 url.dll,FileProtocolHandler` like `open_url`.
- **`engram projects list` is cached for 5 minutes** in a `Lazy<Mutex<Option<...>>>` (`KNOWN_PROJECTS_CACHE`). The `enrich_projects` batch resolves it once and reuses across all paths. Don't call `engram` per-row.
- **NTFS folder mtime trap**: `scan_projects` looks at the newest `.jsonl` mtime inside each project folder, NOT the folder mtime, because NTFS doesn't update folder mtime on file modification.
- **`first_cwd_in_jsonls`** reads JSONL files line-by-line until it finds the first `cwd` field — that's the project's real working directory, since the folder name under `~/.claude/projects/` is a sanitized hash.

**React layer** is a 7-tab single-window app: `overview | projects | prs | audit | cleanup | companions | settings`. The active layout is **V3** ([src/v3/AppV3.tsx](src/v3/AppV3.tsx)) — the older V1 ([src/App.tsx](src/App.tsx)) is lazy-loaded only via the console backdoor `cskLayout("v1")`.

State conventions:

- **V3 layout shell**: `.appv3` is `position: fixed; inset: 0` (locked to the viewport). Topbar (52px) + statusbar (28px) are `flex-shrink: 0`; the body grid uses `grid-template-rows: minmax(0, 1fr)` so only sidebar / content / right-panel scroll. Don't break this contract.
- **Per-tab refresh nonces** in `AppV3.tsx` — bumping `refreshNonce` re-runs the data fetch effect.
- **Theme is a `data-theme-v3` attribute on `<body>`** persisted to `localStorage["csk-theme-v3"]`. There are 28 themes under [src/v3/themes/](src/v3/themes/). Adding a theme means: drop the `.css` file, `@import` it from `AppV3.css`, extend `V3_THEME_ORDER` in `AppV3.tsx` and `V3_THEMES` in `views.tsx`. The duplication is technical debt — see `AUDIT.md`.
- **Keyboard shortcuts** (in `AppV3.tsx`): `Ctrl/Cmd+1..7` switches tabs, `Ctrl/Cmd+R` refreshes, `Ctrl/Cmd+,` opens settings, `Ctrl/Cmd+T` cycles theme.
- **Capability allowlist** lives in `src-tauri/capabilities/default.json` — every new `#[tauri::command]` must be permitted there.
- **Companion state** (name, image) is owned by `AppV3.tsx` and passed down to `CompanionsViewV3` via props + setters. Right-panel widget updates live on edit.

## Branch convention

The active branch for desktop work is **`desktopapp`**. `main` still carries the legacy shell-kit history. PRs for the app target `desktopapp`.

## Non-obvious gotchas

- `where code` returns three things on Windows; only `code.cmd` handles `--folder-uri` correctly. The Rust `open_in_vscode` uses `code.cmd` with `--` end-of-options.
- `start /MIN` doesn't propagate to GUI apps that self-activate. The legacy PowerShell brief launches `code.cmd` then `FindWindow` + `ShowWindow(SW_MINIMIZE)` post-launch.
- `SetForegroundWindow` is silently ignored from non-foreground processes — use TOPMOST instead.
- Paths from old JSONL entries may still carry `\\?\` UNC prefixes; the Rust side canonicalizes + strips before returning to JS.
- Vite cannot tree-shake `@import url(...)` — the 28 theme files all ship in the initial bundle. Listed in `AUDIT.md` as a perf CRIT.

## Style rules specific to this repo

- **Never run `pnpm build` or `cargo build` after changes** unless the user asks. Use `pnpm typecheck` to verify TS, and rely on `pnpm tauri dev` for runtime checks.
- **Don't add Python.** The legacy kit deliberately replaced its Python project scanner with native PowerShell.
- **Don't resurrect the shell kit.** Anything new goes into the Tauri side.
- **Conventional commits only**, no AI co-author trailers (per global rule).
