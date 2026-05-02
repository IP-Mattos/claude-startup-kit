# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two coexisting halves of the same product (a Windows-only Claude Code companion):

1. **PowerShell/shell kit** (root: `install.ps1`, `scripts/`, `tests/`, `claude-templates/`) — the shipped product. Idempotent installer that wires hooks into `~/.claude/settings.json`, drops scripts under `~/.claude/scripts/`, and registers a Startup launcher. Pure PowerShell + bash; no runtime dependencies beyond Windows + Claude Code + `gentle-ai` + VS Code.
2. **Tauri rewrite** (`app/`, current branch `feat/tauri-rewrite`) — desktop GUI replacement for the cmd-window startup brief. Tauri 2 + React 19 + Vite. Reuses `~/.claude/scripts/claude-audit.ps1` via shell-out from the Rust side; does NOT replace the installer half.

Treat them as separate codebases that share the `~/.claude/` filesystem contract — don't refactor across the boundary unless asked.

## Commands

### Tauri app (`app/`)
- `pnpm dev` — Vite-only (browser, no Tauri shell)
- `pnpm tauri dev` — full desktop app (use `app/dev.ps1` on Windows; it bootstraps MSVC `vcvars64` so `cargo` finds `link.exe`, then runs `pnpm tauri dev`)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — `tsc && vite build` (frontend only; never run unless asked — see global rule)

### Kit (root)
- `.\install.ps1 [-DryRun] [-Force]` — idempotent install. `-Force` overwrites `startup-kit-config.json`.
- `.\uninstall.ps1` — reverses install (strips hooks, removes user-custom blocks, deletes scripts).
- `Invoke-Pester -Path tests/` — runs Pester tests for `scripts/lib/*.ps1`.
- `Invoke-Pester -Path tests/themes.Tests.ps1` — single test file.

CI (`.github/workflows/ci.yml`) validates `.ps1` / `.sh` / `.bat` / `.json` syntax on push.

## Architecture — Tauri app

Tauri 2 with a tray-icon-only lifecycle: `CloseRequested` hides the window instead of exiting, and the tray icon left-click brings it back. Single window registered in `tauri.conf.json` as `"main"`.

**Rust commands** ([app/src-tauri/src/lib.rs](app/src-tauri/src/lib.rs)) are the API surface invoked from the React layer via `@tauri-apps/api/core`'s `invoke()`. Conventions baked in:

- **Blocking IO is wrapped in `tokio::task::spawn_blocking`** — every `scan_*`, `enrich_*`, `run_audit`, `github_review_queue` follows this. Don't add new commands that block on the async runtime.
- **Path confinement for destructive ops**: `cleanup_apply` canonicalizes both the candidate path AND the allowed roots (`~/.claude/{logs,backups,projects}`), then `starts_with`-checks. Symlinks are refused outright (via `symlink_metadata`). Any new IPC that deletes files must follow the same pattern.
- **`\\?\` UNC prefix is stripped** after `fs::canonicalize` on Windows so paths round-trip cleanly through IPC and back into git/explorer.
- **External CLIs** (`gh`, `engram`, `git`, `code.cmd`, `powershell`, `rundll32`) are shelled out via `Command`. Never use `cmd.exe /c` for URLs (the `&` in PR query strings becomes a command separator) — use `rundll32 url.dll,FileProtocolHandler` like `open_url`.
- **`engram projects list` is cached for 5 minutes** in a `Lazy<Mutex<Option<...>>>` (`KNOWN_PROJECTS_CACHE`). The `enrich_projects` batch resolves it once and reuses across all paths. Don't call `engram` per-row.
- **NTFS folder mtime trap**: `scan_projects` looks at the newest `.jsonl` mtime inside each project folder, NOT the folder mtime, because NTFS doesn't update folder mtime on file modification.
- **`first_cwd_in_jsonls`** reads JSONL files line-by-line until it finds the first `cwd` field — that's the project's real working directory, since the folder name under `~/.claude/projects/` is a sanitized hash.

**React layer** ([app/src/App.tsx](app/src/App.tsx)) is a 5-tab single-window app: `companion | projects | audit | prs | cleanup`. Each tab is a `React.lazy()` view under [app/src/views/](app/src/views/). State conventions:

- **Per-tab refresh nonces** in `App.tsx` — bumping `refreshNonces[tab]` forces the corresponding view to re-fetch via `useEffect` dep. Use this instead of imperative refs.
- **Theme is a `data-theme` attribute on `<html>`** persisted to `localStorage["csk-theme"]`. Themes are CSS files under [app/src/themes/](app/src/themes/) loaded globally; adding a theme means adding `themes/<name>.css`, importing it from `main.tsx`, and extending `THEMES` in [app/src/types.ts](app/src/types.ts).
- **Keyboard shortcuts** are global: `Ctrl/Cmd+1..5` switches tabs, `Ctrl/Cmd+K` jumps to projects search, `Ctrl/Cmd+R` refreshes the current tab.
- **Capability allowlist** lives in `app/src-tauri/capabilities/default.json` — every new `#[tauri::command]` must also be permitted there.

## Architecture — PowerShell kit

`install.ps1` is the contract. Anything in `scripts/` gets copied to `~/.claude/scripts/` verbatim; `scripts/lib/*.ps1` is loaded by `startup-brief.ps1` via dot-sourcing. Hook entries are merged into `~/.claude/settings.json` `hooks.SessionStart` and detected by command/marker so re-runs are no-ops.

User edits to `~/.claude/CLAUDE.md` are protected by `<!-- user-custom:... -->` markers that live OUTSIDE gentle-ai's managed blocks (gentle-ai sync rewrites its own blocks; ours survive because they sit between them).

## Non-obvious gotchas (from README)

- `.ps1` files need a **UTF-8 BOM** for box-drawing/Unicode rendering. Installer adds it post-copy.
- `[System.Text.Encoding]::UTF8` ships a BOM on Windows PowerShell 5.1 — that BOM leaks into piped subprocesses. Use `[System.Text.UTF8Encoding]::new($false)` for stdin/stdout.
- `where code` returns three things on Windows; only `code.cmd` handles `--folder-uri` correctly. The Rust `open_in_vscode` uses `code.cmd` directly.
- `start /MIN` doesn't propagate to GUI apps that self-activate. The PowerShell brief launches `code.cmd` then `FindWindow` + `ShowWindow(SW_MINIMIZE)` post-launch.
- `SetForegroundWindow` is silently ignored from non-foreground processes — use TOPMOST instead.
- Paths from old JSONL entries may still carry `\\?\` UNC prefixes; the Rust side canonicalizes + strips before returning to JS.

## Style rules specific to this repo

- **Never run `pnpm build` or `cargo build` after changes** unless the user asks. Use `pnpm typecheck` to verify TS, and rely on `pnpm tauri dev` for runtime checks.
- **Don't add Python.** The kit deliberately replaced its Python project scanner with native PowerShell (`scripts/lib/scan-projects.ps1`).
- **Keep the Tauri↔kit boundary**: the Tauri app may shell out to scripts under `~/.claude/scripts/` (e.g. `claude-audit.ps1`), but the kit never depends on the app.
- **Conventional commits only**, no AI co-author trailers (per global rule).
