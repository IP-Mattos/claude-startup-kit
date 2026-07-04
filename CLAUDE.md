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

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs frontend typecheck; `cargo check`, `cargo test`, and `cargo clippy -D warnings` against `src-tauri/`; `go build` + `go test` for the claudewatch TUI (`tools/claudewatch/`); and a legacy PowerShell parse pass. Dependabot config lives at `.github/dependabot.yml`.

## Architecture

Tauri 2 with a tray-icon-only lifecycle: `CloseRequested` hides the window instead of exiting; tray left-click brings it back. Single window registered in `tauri.conf.json` as `"main"`.

**Rust commands** ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) are the API surface invoked from React via `@tauri-apps/api/core`'s `invoke()`. Conventions:

- **Blocking IO is wrapped in `tokio::task::spawn_blocking`** — `scan_projects`, `enrich_projects`, `run_audit`, `cleanup_plan`/`cleanup_apply`, `open_in_vscode`, `open_path_in_explorer`, `open_in_tui`, `git_last_commit`, `engram_project_goal`, `engram_known_projects`, the update checkers, and the rest. Don't add new commands that block on the async runtime.
- **Path confinement for destructive ops**: `cleanup_apply` canonicalizes both the candidate path AND the allowed roots (`~/.claude/{logs,backups,projects}`), then `starts_with`-checks. Symlinks are refused outright (via `symlink_metadata`).
- **`validate_open_path()`** is the gate for any IPC that opens or executes against a user-supplied path. It rejects: empty strings, leading `-` (looks like a flag), leading `/` (Unix-style on Windows), `shell:` / `file://` / `ms-windows-store:` / `::{` protocol prefixes, UNC paths (`\\server\share`), non-existent paths. New IPC that touches the FS must call it first.
- **`\\?\` UNC prefix is stripped** after `fs::canonicalize` on Windows so paths round-trip cleanly through IPC and back into git/explorer.
- **External CLIs** (`git`, `engram`, `gh`, `powershell`, `gentle-ai`, `claude`, `explorer`, `reg`, `rundll32`, `taskkill`/`tasklist`) are shelled out via `Command` (through the `silent_command` helper so no console window flashes). Never use `cmd.exe /c` for URLs (the `&` in query strings becomes a command separator) — use `rundll32 url.dll,FileProtocolHandler` like `open_url`.
- **`engram projects list` is cached for 5 minutes** in a `Lazy<Mutex<Option<...>>>` (`KNOWN_PROJECTS_CACHE`). The `enrich_projects` batch resolves it once and reuses across all paths. Don't call `engram` per-row.
- **NTFS folder mtime trap**: `scan_projects` looks at the newest `.jsonl` mtime inside each project folder, NOT the folder mtime, because NTFS doesn't update folder mtime on file modification.
- **`first_cwd_in_jsonls`** reads JSONL files line-by-line until it finds the first `cwd` field — that's the project's real working directory, since the folder name under `~/.claude/projects/` is a sanitized hash.

**React layer** is an 8-tab single-window app: `overview | projects | conversations | trello | audit | cleanup | settings | claude` ([src/v3/v3types.ts](src/v3/v3types.ts)). Navigation is two-track ([src/constants/v3Nav.ts](src/constants/v3Nav.ts)): the sidebar carries the six operational tabs, the topbar carries the meta tabs (`claude` = Gentle-AI stack view, `settings`). The shell is **V3** ([src/v3/AppV3.tsx](src/v3/AppV3.tsx), ~470 lines) — it owns cross-tab state and renders views from [src/views/v3/](src/views/v3/), shared components from [src/components/v3/](src/components/v3/), hooks/utilities from [src/lib/](src/lib/). The old V1 layout (`src/App.tsx`), `src/v3/views.tsx`, and the `cskLayout` console backdoor are all deleted — don't reference them.

State conventions:

- **V3 layout shell**: `.appv3` is `position: fixed; inset: 0` (locked to the viewport). Topbar (38px) + statusbar (28px) are fixed-height with `flex-shrink: 0`; the body grid is `220px | minmax(0, 1fr) | 280px` columns with `grid-template-rows: minmax(0, 1fr)` so only sidebar / content / right-panel scroll. Don't break this contract.
- **App-level `refreshNonce`** in `AppV3.tsx` — bumping it (Ctrl+R, sidebar "run audit", retry banner) re-runs the shared fetch effect (`scan_projects` + `engram_known_projects` + `run_audit` + enrichment), which feeds Overview / Projects / Audit and the right panel. The other views (Conversations, Trello, Claude, Cleanup) fetch their own data on mount, so switching to them re-fires their IPC.
- **Per-source fetch errors** are collected in `fetchErrors` and surfaced via the retry banner — backend failures must not masquerade as empty states.
- **Theme is a `data-theme-v3` attribute on `<body>`** (`light` = no attribute) persisted to `localStorage["csk-theme-v3"]`. There are 8 themes under [src/v3/themes/](src/v3/themes/), **lazy-loaded** via `import.meta.glob` in [src/lib/themes.ts](src/lib/themes.ts); `vite.config.ts` `manualChunks` splits each into its own `theme-<name>` chunk. Adding a theme means: drop `name.css` in `src/v3/themes/` (rules scoped under `body[data-theme-v3="name"]`), then register it in `src/lib/themes.ts` — add the id to `V3_THEME_ORDER` and an entry to `V3_THEME_OPTIONS` (label + swatch). The glob and the chunk split pick it up automatically; no `@import`, no `vite.config.ts` edit.
- **Keyboard shortcuts** (in `AppV3.tsx`): `Ctrl/Cmd+1..6` switches the sidebar tabs (order = `KEYBOARD_TAB_ORDER` in `src/constants/v3Nav.ts`), `Ctrl/Cmd+R` refreshes, `Ctrl/Cmd+,` opens settings, `Ctrl/Cmd+T` cycles theme, `Ctrl/Cmd+K` toggles the command palette.
- **i18n**: all user-facing strings go through `useT()` ([src/lib/i18n.ts](src/lib/i18n.ts), `en`/`es` with auto-detect). Don't hardcode UI copy.
- **Capability allowlist** lives in `src-tauri/capabilities/default.json` — every new `#[tauri::command]` must be permitted there.
- **Companion state** (name, image) is owned by `AppV3.tsx` (persisted to `localStorage`) and passed down to `SettingsView` (which embeds `CompanionsView`) via props + setters. Right-panel widget updates live on edit.

## Branch convention

The active branch for desktop work is **`desktopapp`**. `main` still carries the legacy shell-kit history. PRs for the app target `desktopapp`.

## Non-obvious gotchas

- The Rust `open_in_vscode` resolves `Code.exe` from the registry (`HKCU\Software\Classes\Applications\Code.exe\shell\open\command`, same handler as Explorer's "Open with Code") and launches it directly — NOT `code.cmd`, whose cmd wrapper flashes a console window and can hang if cli.js' IPC handshake stalls.
- `start /MIN` doesn't propagate to GUI apps that self-activate. The legacy PowerShell brief launches `code.cmd` then `FindWindow` + `ShowWindow(SW_MINIMIZE)` post-launch.
- `SetForegroundWindow` is silently ignored from non-foreground processes — use TOPMOST instead.
- Paths from old JSONL entries may still carry `\\?\` UNC prefixes; the Rust side canonicalizes + strips before returning to JS. Leaking a `\\?\`-prefixed path into VS Code's workspace state crashes the Claude Code extension's activation (`TypeError: V is not iterable`).
- Every spawned CLI subprocess gets a `conhost.exe` window by default because Tauri is a GUI app — go through `silent_command()` (`CREATE_NO_WINDOW`) or the user sees a flicker on every tab switch.
- The claudewatch TUI binary (`~/claudewatch/claudewatch.exe`) can be locked while running; the installer renames it aside (`.exe.old`) and drops the fresh copy in — Windows allows renaming a running exe but not overwriting it.

## Style rules specific to this repo

- **Never run `pnpm build` or `cargo build` after changes** unless the user asks. Use `pnpm typecheck` to verify TS, and rely on `pnpm tauri dev` for runtime checks.
- **Don't add Python.** The legacy kit deliberately replaced its Python project scanner with native PowerShell.
- **Don't resurrect the shell kit.** Anything new goes into the Tauri side.
- **Conventional commits only**, no AI co-author trailers (per global rule).
