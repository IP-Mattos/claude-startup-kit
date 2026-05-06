# Changelog

## 0.1.27 — 2026-05-05

### Fixed
- **Sync no longer fails with `Author identity unknown`** on machines where the user never set `user.email` / `user.name` globally. CSK was running plain `git commit` in the sync repo, which git refuses without an identity. New `git_commit_in` helper passes the identity inline via `-c user.name=… -c user.email=…` (CSK-bot values: `Claude Startup Kit Sync <csk-sync@local>`) so the commit succeeds without us touching the user's global git config — same shape as the inline identity we use for release tags. Applied to all three commit callsites: `init: csk sync` first commit, `sync` amend, and the `sync` fallback when there's no prior commit.

## 0.1.26 — 2026-05-05

### Fixed
- **No more flashing/sticky cmd window when opening a project**. `open_in_vscode` was launching `code.cmd` (a CLI wrapper that runs `Code.exe cli.js …`) which flashes a console window and on some setups stays visible until cli.js exits — sometimes never. Switched to spawning `Code.exe` directly with `silent_command` (`CREATE_NO_WINDOW`). Mirrors what Explorer's "Open with Code" registered handler does (queried from `HKCU\Software\Classes\Applications\Code.exe\shell\open\command`). New `resolve_vscode_exe()` helper checks the registry first, falls back to `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` and the two `Program Files` install dirs. Dropped the `--` end-of-options separator since `Code.exe` doesn't need it and `validate_open_path` already rejects leading-`-` paths.

## 0.1.25 — 2026-05-05

ROOT CAUSE for the recurring **Claude Code sidebar fails to load** bug the user reported across v0.1.21, v0.1.22, v0.1.23, and v0.1.24.

### Fixed
- **`validate_open_path` strips the `\\?\` UNC prefix that `canonicalize` adds on Windows.** Every consumer (`open_in_vscode`, `open_path_in_explorer`) was handing VS Code paths like `\\?\C:\Users\darkm\OneDrive\Desktop\Code\PolyMarket`. VS Code wrote those verbatim into its workspace recents — visible directly in the user's "Recent" list mixed with normal `C:\...` entries. When the Claude Code extension activates and iterates `vscode.workspace.workspaceFolders`, the inconsistency crashes the iterator with `TypeError: V is not iterable` and the `claudeVSCodeSidebarSecondary` view refuses to load (see [anthropics/claude-code#16634](https://github.com/anthropics/claude-code/issues/16634), [#34678](https://github.com/anthropics/claude-code/issues/34678)). Same project opened from Explorer's "Open with Code" never reproduces because Explorer doesn't go through `canonicalize` and produces clean paths.

### Why we shipped 4 wrong fixes first
- v0.1.23 PATH augmentation (right call, wrong cause)
- v0.1.24 detach via `cmd /c start` (right call, wrong cause)
- Two assumptions about extension state and process trees that distracted from the actual evidence: the user's recents list literally showed paths with `\\?\` prefix on the broken entries.

CLAUDE.md already documented the rule: *"`\\?\` UNC prefix is stripped after `fs::canonicalize` on Windows so paths round-trip cleanly through IPC and back into git/explorer."* The codebase has a `strip_unc_prefix` helper used in 1 of 2 canonicalize call sites — `validate_open_path` was the one that forgot to call it.

## 0.1.24 — 2026-05-05

Audit-driven CRIT batch from a 12-finding review. Same theme as v0.1.23: stop the **inconsistent-state** class of bugs the user has been hitting (banner shows X, action does Y; cache shows old, reality is new; cryptic error vs actionable message).

### Fixed
- **VSCode opens detached now** — was launched via `Command::new("code.cmd")` which left VS Code in CSK's process tree. The Claude Code extension's `claudeVSCodeSidebarSecondary` view failed to bootstrap when opened from CSK but loaded fine when opened from Windows Explorer. Switched to `cmd /c start "" code.cmd -- <path>` which detaches the same way `ShellExecute` does. Same `--` end-of-options guard, no security regression.
- **Mirror-skew has its own error now** — `apply_app_update` used to return `"no update available"` whenever the renderer-facing banner (GitHub Releases REST API) and the Tauri updater (`latest.json` on the public mirror repo) disagreed during the brief publish window. Now returns `"MIRROR_LAG: el espejo todavía no publicó esta versión. Probá de nuevo en 1-2 min."` so the user knows to retry instead of opening a bug.
- **PATH augmenter completed** — v0.1.23 missed `gh` (`%PROGRAMFILES%\GitHub CLI\`), `git` (`%PROGRAMFILES%\Git\cmd\` and `bin/`), `powershell` (`%WINDIR%\System32\WindowsPowerShell\v1.0\`), and `System32` itself. All added — the entire Sync flow, PR queue, update channel, and gentle-ai self-upgrade are immune to stripped-PATH inheritance now, not just engram and gentle-ai.
- **Cache invalidation on mutating IPCs** — `apply_gentle_ai_update`, `apply_stack_update`, `sync_import`, `toggle_mcp_server`, and `restore_settings_backup` were all leaving the 5-min `WORKSPACE_SUMMARY_CACHE` and `KNOWN_PROJECTS_CACHE` stale after mutating the underlying state. Now each one busts the relevant cache before returning.
- **WorkspaceCard re-fetches on `csk:workspace-invalidate`** — even with the backend cache busted, the right-panel widget was bound to its mount-time state. Now listens for a custom event dispatched by `useUpdates.applyGentleAi` and `useStackUpdates.applyAll` so the widget updates immediately.
- **`spawn X: program not found` errors translated** — was leaking raw Windows IO errors to red banners (`spawn engram: The system cannot find the file specified. (os error 2)`). New `format_spawn_error` helper detects `ErrorKind::NotFound` and emits a localized hint pointing at the most likely cause (recent install + stale PATH). Applied to all 13 shell-out callsites.

### Added
- **`format_spawn_error(program, err)`** helper in `lib.rs`. Reusable for any future shell-out.
- **`invalidate_known_projects_cache()`** and **`invalidate_workspace_summary_cache()`** helpers. Tiny but make every mutating IPC's responsibility explicit and grep-able.
- **`audit_resolve_delete` IPC** with explicit allowlist (currently just `~/.claude/settings.local.json`). Moves the file to `~/.claude/backups/audit-<unix-ts>/` instead of permanent delete so the user can recover.

### Fixed (audit Resolver UX)
- **DRIFT/`settings.local.json` Resolver actually resolves now** — was mapped to `OpenInVscode`, so the user got a "Done ✓" badge but the finding kept reappearing on every audit run because nothing on disk changed (user reported: "le doy resolver y dice hecho y luego vuelve a pedir resolve, no hay feeling, no hay indicador, se abre vscode pero qué haga ahí? eso debería ser automático"). Now mapped to `DeleteFile` → confirm modal with finding-specific copy → file moved to backups → audit refresh → finding gone. Reversible (file is in backups, not deleted).
- **Confirm modal for `settings.local.json` is finding-specific** — was the generic "Permanently delete X?" copy. Now explains exactly what the local override does, that the local permissions are lost, and where the file goes.

## 0.1.23 — 2026-05-05

Systemic fix for the **"program not found"** class of errors that kept regressing on different IPCs (`engram` from sync's clone, `code.cmd` from Audit's "Resolver" and Projects' "Abrir") after auto-updates.

### Root cause
After a Tauri auto-update, the new app instance can inherit a `PATH` that's missing per-user install dirs (`%LOCALAPPDATA%\engram\bin`, `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin`, `~\go\bin`, `~\bin`, `%APPDATA%\npm`). Each shell-out — `engram`, `code.cmd`, `git`, `gh`, `bash` — could then fail with "program not found" even though the same command works from a fresh terminal. We had been patching this **per tool** (`resolve_gentle_ai` in v0.1.11, `resolve_managed_tool` in v0.1.19/v0.1.21) but new shell-outs kept regressing.

### Fixed
- **Process `PATH` augmented at boot** via new `augment_path_with_user_bin_dirs()`, called as the first thing in `run()` before the Tauri builder spins up. Prepends well-known user-scoped bin dirs to `PATH` if they exist AND aren't already there. Every `Command::new(<bare-name>)` downstream — sync's `engram`, audit/projects' `code.cmd`, gentle-ai, gh, git, bash — now resolves correctly without needing per-tool resolvers.
- All paths are env-var derived (`LOCALAPPDATA`, `APPDATA`, `USERPROFILE`/`HOME`, `PROGRAMFILES`, `PROGRAMFILES(X86)`) so this is universal across machines.
- No-op on machines where every dir is already in `PATH` (e.g., users who configured everything via system settings).

## 0.1.22 — 2026-05-05

Drop the `KIT` audit category. It was a verbatim port of the legacy PowerShell kit's `claude-audit.ps1` that checked for a `~/.claude/scripts/.kit-version` marker file the legacy installer dropped. With the legacy kit retired (it lives under `legacy/` and is no longer the shipping product), the check became a permanent false positive: every fresh user saw "No .kit-version marker — kit may not be installed" and the **Resolver** button failed with "kit config not found at C:\\Users\\\\.claude\\scripts\\startup-kit-config.json" because `reinstall_kit` was hardcoded to drive the legacy installer.

### Removed
- **`audit_kit`** function and its call site in `run_audit_blocking`.
- **`KIT` arm** in `infer_action`.
- **`reinstall_kit` IPC** (Rust async command, registered handler, frontend `invoke` call).
- **`AuditAction::ReinstallKit`** Rust enum variant.
- **`{ kind: "reinstall_kit" }`** TypeScript union member, the `KNOWN_ACTION_KINDS` entry, and the matching `normalizeAction` arm.
- **`PendingConfirm` arm** for `reinstall_kit` and the `confirmStrings` case.
- **`audit.confirm_reinstall_*`** i18n keys.

### Note
`.kit-version` stays in `KIT_WHITELIST` of `audit_scripts` — it's a benign filename match that prevents the marker from being re-flagged as a "non-kit file" if a user does still have the legacy kit installed alongside the Tauri app.

## 0.1.21 — 2026-05-05

Two follow-ups to the v0.1.20 install wizard release.

### Fixed
- **Install wizard auto-closes** — was using `cmd /k` which kept the new console window open after the wizard exited (user had to close it manually). Now uses `cmd /c <wizard> & timeout /t 8 /nobreak` with `CREATE_NEW_CONSOLE`: wizard runs, then a visible 8-second countdown, then the window auto-closes. `/nobreak` so the countdown can't be skipped by accident.
- **`gga` (and any tool installed as a PowerShell wrapper or .cmd shim) now detected** — the v0.1.19 detection-override only looked for `<name>.exe` on PATH + a small list of fallback dirs. gentle-ai's installer drops `gga` as a bash script next to a `gga.ps1` wrapper in `~\bin\`, so the resolver missed it. Now scans `.exe` / `.cmd` / `.bat` / `.ps1` extensions and adds `%APPDATA%\npm\` (npm-global target) to the fallback dir list. `read_managed_tool_version` invokes via `cmd /c` for `.cmd`/`.bat` and `powershell -NoProfile -Command "& '<path>'"` for `.ps1`.

## 0.1.20 — 2026-05-05

Per-row "Instalar" button on the Stack tools card. Closes the missing-affordance gap when gentle-ai reports a managed tool as not installed — before this you could see "No instalada" but had no way to act on it from the app.

### Added
- **`open_stack_install_wizard` IPC** — spawns `gentle-ai install` (the upstream interactive wizard) in a new visible console window via `cmd /c start "" cmd /k`. Fire-and-forget so CSK stays responsive; `/k` keeps the window open after the wizard exits so the user reads the final summary. There's no `gentle-ai install <name>` upstream — the wizard configures the whole catalog at once, so every per-row "Instalar" button opens the same flow.
- **`StackToolRow` per-row "Instalar" button** on `not_installed` rows. Visually mirrors the existing per-row "Update now" affordance (`v3-update-row-action` class). Tooltip explains it opens gentle-ai's wizard.
- **`useStackUpdates.openInstallWizard`** — invokes the IPC, surfaces failures via the existing `error` field.

### Why not per-tool installer URLs
Hardcoding `irm <url> | iex` per tool is brittle — if Gentleman-Programming moves an installer, CSK starts lying. Delegating to the upstream wizard keeps the source of truth where it belongs.

## 0.1.19 — 2026-05-05

Detection-override for the Stack tools card. gentle-ai's `update` table is the source of truth for *versions*, but its detector occasionally reports a tool as `[--]` (not installed) when the binary is reachable on the user's machine — engram and gga have both hit this. Without a fix, the UI claims "No instalada" right next to a working `engram --version`.

### Fixed
- **`check_stack_update` overrides false `not_installed` rows** by walking PATH + well-known install dirs the same way `resolve_gentle_ai` already does, then probing `<binary> --version` / `<binary> version`. If a real semver comes back, the row's state is recomputed against `latest` (`up_to_date` vs `update_available`). Fixes engram showing as "No instalada" on machines where `engram --version` works from a fresh terminal.

### Added
- **`resolve_managed_tool(name)`** — generic resolver mirroring `resolve_gentle_ai`. PATH walk first; falls back to `%LOCALAPPDATA%\<name>\bin\`, `~\.local\bin\`, `~\go\bin\`, `~\bin\`, `~\AppData\Local\<name>\bin\`. All paths derived from env vars — no machine-specific absolutes.
- **`read_managed_tool_version(program)`** — best-effort version probe trying both `--version` and `version`, scanning stdout then stderr for the first semver triplet. Used by the override path; reusable for any future stack-tool detection.

### Refactored
- **`extract_semver(text)`** factored out of `read_gentle_ai_version`. Same logic, now shared with the override path.

## 0.1.18 — 2026-05-05

INFO-tier cleanup pass from the 5-agent audit (memo: engram #875). The two deferred WARN items (AppV3 double-fetch refactor + CSP hardening) move to v0.1.19 — they need careful work that doesn't fit cleanly in a cleanup release.

### Changed
- **`apply_stack_updates` and `check_stack_updates` renamed** to `apply_stack_update` / `check_stack_update` for symmetry with `apply_app_update`, `apply_gentle_ai_update`. JS callsites in `useStackUpdates.ts` updated; `invoke_handler!` registration follows.
- **`scan_projects` returns `Result<Vec<Project>, String>`** instead of swallowing join errors with `unwrap_or_default()`. The frontend `AppV3.tsx` already wrapped the call in `trap("Projects", [])` so backend errors now flow into the existing fetch-error banner instead of masquerading as an empty list.
- **`audit_kit` surfaces IO errors as a WARN finding** instead of pretending success with an empty version string. If `.kit-version` is unreadable (permission, file lock), the audit panel now shows the underlying error.

### Fixed
- **`AuditView` "Done ✓" timeout cancelled on unmount AND on rapid re-fire** — used to leak a `setRecentlyDoneId(null)` setState onto an unmounted component (React 19 dev warning), and a fast second action could clobber a fresh badge. Now tracked in a `useRef`, cleared in cleanup and at the start of each new action.
- **`useUpdates` per-channel error state** — was sharing one `error` field, so a transient `gentle-ai` failure overwrote a still-relevant app-update error and vice versa. Split into `appError` / `gentleAiError`. Settings panel renders both independently.
- **`toggle_mcp_server` plugin branch no longer silently no-ops** when `enabledPlugins` isn't an object — returns `Err("enabledPlugins is not an object")` so the renderer can react.

### Removed
- **5 dead helpers** in `src/lib/format.ts`: `activityLabel`, `activityLabelEn`, `tierClass`, `hexId`, Spanish `friendlyError`. Unused since the v3 layout migration.
- **Stale "moved to" relocation comments** in `AppV3.tsx` from a previous refactor. Were duplicated and added noise without informing.
- **`useStackUpdates.lastApplyOutput`** — exposed in the hook contract but never consumed by any consumer. Dead surface area.

### Refactored
- **`IS_TAURI` extracted** to `src/lib/env.ts`. The literal `typeof window !== "undefined" && "__TAURI_INTERNALS__" in window` was duplicated VERBATIM in 12 files. Now one source of truth; all 12 files import from `env.ts`.
- **`audit.ts:13`** — `let unknownLevelsLogged` → `const`. Was never reassigned, only mutated via `.add`.

### Out of scope (v0.1.19)
- AppV3 + view double-fetch refactor (lift state to context).
- CSP `'unsafe-inline'` removal with nonce/hash.

## 0.1.17 — 2026-05-05

WARN-tier follow-up to the v0.1.16 audit-pass. Performance, security, and accessibility wins; INFO-tier cleanup lands in v0.1.18.

### Performance
- **`audit_disk` does ONE recursive walk** of `~/.claude` instead of 5. Previously it recursed once for total size, then again for `projects/`, `logs/`, `backups/`, then a fifth time for big-JSONL detection. Single pass now accumulates total + per-bucket totals + collects large JSONLs in one shot. On a multi-GB tree that's roughly ⅕ the syscall cost per audit run.
- **`workspace_summary` cached for 5 minutes** (mirroring the existing `KNOWN_PROJECTS_CACHE` pattern). The right-panel WorkspaceCard used to fire `engram` + a 200-JSONL scan on every mount (3-5 s wall time). The IPC now early-returns from cache.
- **`count_skill_usage` cached for 5 minutes.** Used by the WorkspaceCard's "skills used" stat. Was rescanning ~400 MiB of JSONL substrings every mount with no cache.
- **`enrich_projects` semaphore-capped at 8 concurrent workers** via `tokio::sync::Semaphore`. With 50+ projects, the unbounded fan-out raced the Tokio blocking pool and queued behind a single-threaded engram CLI.
- **`read_last_n_lines` reads from EOF, capped at 256 KiB.** `audit_logs` was loading the whole `startup-kit.log` into a Vec on every audit run. Now it seeks from the end in 8 KiB chunks until it has N newlines or hits the cap.

### Security
- **`sync_setup` rejects `repo_name` with `/`, `\`, or leading `-`** — same shape as the v0.1.16 `clone_project` validation. Closes a confused-deputy with the user's `gh` PAT (a renderer-supplied `org/name` would have overridden the resolved gh user).
- **TODO marker added on `GENTLE_AI_INSTALLER_URL`** — the `irm install.ps1 | iex` flow targets `main` branch unsigned. Pinning to a commit SHA needs upstream coordination; flagged inline so we don't lose it.

### Audit
- **"Large JSONL" findings now include the full path in detail** so `infer_action`'s `extract_windows_path` resolves to `OpenInExplorer`. Previously the title only had the filename so the explorer-open arm was dead code (fell through to `NavigateTo cleanup`).

### Accessibility
- **Click-target sizes ≥ 32 px** on `.v3-link`, `.v3-finding-resolve`, and `.v3-btn-icon`. WCAG 2.5.5 / 2.5.8. The link variant ("Buscar ahora", "Ver todos") is used as a button across Settings / Overview / Sync / Claude tabs.
- **`.v3-recent-ago` contrast fix** — was `--v3-text-4` (`#9CA3AF`) on white, 2.85:1, failing WCAG AA. Now `--v3-text-3` (`#6B7280`, 4.83:1).
- **`.v3-update-row-label` no longer overflows** when paired with long Spanish status strings on the right side. Added `min-width: 0; flex: 0 1 auto;`.

### Out of scope (v0.1.18)
- AppV3 + view double-fetch refactor (lift to context) — needs a careful pass to avoid regressions.
- CSP hardening (`'unsafe-inline'` removal with nonce/hash) — needs Tauri 2 spec verification first.

## 0.1.16 — 2026-05-05

Audit pass — six critical findings from the 5-agent parallel sweep are fixed in this release. WARN-tier and INFO-tier items land in v0.1.17 / v0.1.18.

### Fixed (security)
- **Path traversal in `clone_project`** — the renderer-supplied `name` flowed through `Path::join`, which on Windows replaces the base when the segment is absolute (`C:\...`) and walks up the tree on `..`. A tampered sync mirror could feed `name = "..\\Startup\\foo"` and write outside the user's chosen target dir. Now we reject path separators / `..` / `:` / leading `-` in `name`.
- **`git clone` flag injection in `clone_project` and `sync_setup`** — the URL was passed to `git clone` without `--`, so `--upload-pack=evil` style strings were parsed as flags (historic git RCE class). Now we insert `--` before the URL and reject schemes other than `https://`, `git@`, `ssh://`, `git://`.

### Fixed (functionality)
- **Project goals never appeared on Overview / Projects** — `enrich_projects` returned `Vec<EnrichedProject>` from Rust but the renderer typed it as `Record<string, EnrichedProject>` and looked up by `enrichment[p.path]`, silently getting `undefined` every time. The Rust side now returns `HashMap<String, EnrichedProject>` so the renderer's lookup actually works.
- **"Resolver" button never appeared on non-kit-script findings** — `audit_scripts` emitted "Non-kit file in ~/.claude/scripts/: …" at INFO level, but `push_finding` skips action inference for INFO. Bumped that finding to WARN, added the matching `OpenInExplorer` arm in `infer_action`, and routed `~/.claude/scripts/` paths through `claude_path_string` for proper canonicalization.
- **`check_stack_updates` / `apply_stack_updates` failed silently after auto-update** — both shelled out to bare `gentle-ai` instead of `resolve_gentle_ai()`. The Tauri auto-updater hands the new app instance a PATH that's missing `%LOCALAPPDATA%\gentle-ai\bin\` so the spawn returned ENOENT, the Stack tools card showed "No managed tools detected", and "Update all" silently no-op'd. Both now use the existing `resolve_gentle_ai()` helper.

### Fixed (UX / accessibility)
- **Filter chip INFO color clashed with WARN** — both rendered amber when active so toggling the filter felt unresponsive. Now `chip-info.active` uses the calm blue `--v3-info` token like the row tints.
- **`<ConfirmModal>` did not trap focus** — Tab escaped the dialog into background controls, and `aria-modal="true"` was lying. Added: focus moves to Cancel on open, Tab/Shift-Tab cycles between Cancel and Confirm only, focus restores to the previously-active element on close.

### Projects scanner — also from v0.1.15
- `scan_projects` now requires a project-marker file (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `requirements.txt`, `pubspec.yaml`, `mix.exs`, `tsconfig.json`, `deno.json`, `.project`, `*.sln`) so umbrella dirs like `Desktop` / home don't show up as workspaces.

## 0.1.15 — 2026-05-05

### Fixed
- **"Update all" did nothing when the only pending update was gentle-ai itself.** `gentle-ai upgrade` cannot replace its own running binary on Windows; it logs `manual update required` and exits 0 with `1 skipped`. CSK was returning that output verbatim and the table showed "everything done" while gentle-ai stayed on the old version. `apply_stack_updates` now detects the self-skip and falls back to running `irm install.ps1 | iex` (same flow as the per-row gentle-ai update button), all in one click.
- **Stack-update parser absorbed the install hint into the `latest` version string.** When gentle-ai upstream updated its `update` output to inline the install command after the version (`latest: 1.25.6 irm https://...install.ps1 | iex`), the greedy `trim()` captured the whole hint and the UI rendered `v1.25.5 → v1.25.6 irm https://raw.githubusercontent.com/...`. Now we tokenize and take only the first whitespace-delimited word for both `installed:` and `latest:`.
- **Projects tab listed umbrella directories as workspaces.** Claude Code records a session at every cwd you launch it from — paths like `C:\Users\darkm\OneDrive\Desktop` or `~` produced JSONL entries CSK was scanning into "projects". Clicking "Open" then attached VS Code to the whole tree, which broke the Claude Code VS Code extension with `An error occurred while loading view: claudeVSCodeSidebarSecondary`. `scan_projects` now requires at least one project-marker file (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `requirements.txt`, `pubspec.yaml`, `mix.exs`, `tsconfig.json`, `deno.json`, `.project`, `*.sln`) to consider a directory a workspace.

## 0.1.14 — 2026-05-05

### Added
- **Stack tools card in Settings → Updates** — new section that maps over `check_stack_updates()` and lists every tool gentle-ai manages (engram, gga, opencode-subagent-statusline, opencode-sdd-engram-manage, gentle-ai itself). Each row shows name, current/latest versions, and per-row state (`up to date`, `vX.Y → vX.Y+1`, or `not installed`). When upstream gentle-ai adds a new tool to its catalog, it appears here automatically — zero CSK code changes required.
- **"Update all" button** that runs `gentle-ai upgrade` across the whole stack in one click. Gated behind a `<ConfirmModal>` because it kills running tool processes (engram, gga) so Windows can replace the binaries.
- **`useStackUpdates` hook** with the same 24h-cooldown pattern as `useUpdates`, persisted in localStorage; manual "Buscar ahora" forces a refresh.
- ~10 new i18n keys (en + es): `settings.stack_*`.

### Changed
- **`apply_stack_updates` now kills `engram.exe` / `gga.exe` before delegating to `gentle-ai upgrade`** — gentle-ai upstream doesn't do this dance itself, so on Windows the upgrade was failing with "rename ...engram-upgrade-N" because the binary was live (MCP servers spawned by every active Claude Code session). CSK fills the gap so single-click stack updates actually work.
- **Settings → Updates card no longer shows the per-row gentle-ai entry** — gentle-ai is part of the Stack tools card now. CSK self-update stays in Updates because Tauri-plugin atomic-restart is conceptually distinct.

### Note
Single source of truth for the stack is now `gentle-ai update`. CSK parses its table — no `--json` flag needed (the format is regular). When gentle-ai upstream gets a `--json` flag, swap the parser; rest of the flow is the same.

## 0.1.13 — 2026-05-05

### Added (backend only — UI lands in v0.1.14)
- **Stack updates via gentle-ai** — two new IPC commands that delegate the entire managed-CLI ecosystem (engram, gga, opencode-subagent-statusline, opencode-sdd-engram-manage, gentle-ai itself) to a single source of truth instead of reimplementing each channel:
  - `check_stack_updates` — runs `gentle-ai update`, parses the table into `StackToolStatus { name, installed, latest, state }` rows where `state` is `up_to_date | update_available | not_installed`. Soft-fails to an empty list if `gentle-ai` isn't on PATH.
  - `apply_stack_updates` — runs `gentle-ai upgrade` and returns the captured stdout for the renderer to display.
- Lightweight in-house parser (no `regex` dep) keys off the `[STATE]` marker + `installed:` / `latest:` literals, so new tools the upstream gentle-ai adds in the future surface here automatically with zero code changes here.
- CSK self-update (the Tauri updater plugin) stays separate by design — atomic binary swap with Ed25519 verification is conceptually different from the `gentle-ai upgrade` rolling upgrade.

## 0.1.12 — 2026-05-05

### Changed
- **Audit checks reimplemented natively in Rust.** The Tauri backend's `run_audit` no longer shells out to `~/.claude/scripts/claude-audit.ps1` — every category (PROCESSES, HOOKS, PERMISSIONS, SCRIPTS, PLUGINS, LOGS, DISK, DRIFT, ENV, STARTUP, KIT) runs in-process via `std::fs` + `std::env` + a small handful of `silent_command` calls. The app no longer requires the legacy script's presence to render the Audit tab.
- Title strings preserved verbatim so the existing `infer_action` mapper keeps dispatching the right resolve buttons (`Restore settings backup`, `Reinstall kit`, `Delete file`, etc.) — no UX regression.

### Limitations / TODO
- **NETWORK** category is intentionally a stub on this pass: a single INFO line plus a `// TODO` for a future Win32 `iphlpapi`/`GetExtendedTcpTable` integration (pure-Rust TCP-table enumeration would otherwise require a new dep). The legacy script's network checks were Windows-only too.
- **PROCESSES** still uses one `silent_command("powershell")` call to read `Get-Process`/`StartTime` — replacing it with the `sysinfo` crate is a small follow-up.

## 0.1.11 — 2026-05-04

### Fixed
- **gentle-ai showed "No configurado" after auto-update**, even when the binary was installed and reachable from a fresh terminal. Root cause: the Tauri auto-updater spawns the new app instance with a parent-inherited PATH that lacks user-scoped install dirs (`%LOCALAPPDATA%\gentle-ai\bin\` etc.), so `silent_command("gentle-ai")` resolved nowhere.
- **PATH-scan + known-install-dir fallback**: new `resolve_gentle_ai()` helper iterates the inherited PATH manually (so even truncated PATH inheritance still finds it) and, if that fails, checks `%LOCALAPPDATA%\gentle-ai\bin\gentle-ai.exe`, `%USERPROFILE%\.local\bin\`, `%USERPROFILE%\go\bin\`, and `%USERPROFILE%\AppData\Local\gentle-ai\bin\` for the binary. `read_gentle_ai_version` now uses the resolver, so the Settings → Updates row goes back to "v1.X.X · al día" when gentle-ai is genuinely installed regardless of how the parent process expanded PATH.

## 0.1.10 — 2026-05-04

### Fixed
- **Auto-updater downloaded a 404** because the `latest.json` published to the public mirror still referenced the **private** repo's release URLs (e.g. `github.com/IP-Mattos/claude-startup-kit/releases/download/...`). The plugin updater fetched the manifest from the public endpoint correctly and showed the right "v0.1.X → latest" banner, but clicking "Update now" tried to download the bundle from the private repo and got a 404. Symptoms: red banner `Download request failed with status: 404 Not Found`.
- The mirror step now **rewrites the `latest.json`** in-place before re-uploading: replaces every `https://github.com/<PRIVATE_REPO>/releases/` prefix with `https://github.com/<PUBLIC_REPO>/releases/`. Deterministic string replace, no JSON parsing, fail-loud if no matches were found (in case `tauri-action` ever changes the URL format).
- Hot-fixed the v0.1.9 manifest manually so existing v0.1.7 / v0.1.8 installs can update without waiting for v0.1.10 to land. Future releases inherit the corrected pipeline.

## 0.1.9 — 2026-05-04

### Added
- **Cyber Terminal theme** — 15th theme in Settings → Theme, inspired by a user reference mockup. Monochrome retro-CRT aesthetic: deep olive background `#1F2014`, phosphor pale-lime text, gray-green muted borders, full monospace, hard 1px borders (no radii). Signature moves: corner-bracket frames on every `.v3-card` (top-left + bottom-right via `::before`/`::after`), terminal-prompt `>_` prefix on the greeting, faint CRT scanlines overlay on the content canvas, `[OK]`-style square pills, and a blinking block cursor on primary-button hover.

### Note
Components shown in the reference mockup that don't exist in the app yet (radar widget, sprite mascot, log_stream strip, memory_map bar) are out of scope for a CSS-only theme — those would be React component additions.

## 0.1.8 — 2026-05-04

### Fixed
- **Audit "Resolver" actions had no visible feedback.** Read-only actions like `OpenInVscode` would fire correctly (the file did open in VS Code) but the user couldn't tell — the spinner cleared too fast and nothing in the app surfaced "this happened". Especially confusing when the file opened on a different monitor or behind another window.

### Added
- **"Hecho ✓" pill** rendered in place of the "Resolver" button for ~2.5 s after every successful audit action. Pure feedback — green tinted, with a check icon and a fade-out animation. Both read-only and destructive actions get the indicator.

### Note
This is the **first release that should reach you via the in-app auto-updater alone**. After installing v0.1.7 manually, you should see a banner or `Update now` button in Settings → Updates that pulls v0.1.8 atomically — no manual MSI download.

## 0.1.7 — 2026-05-04

### Fixed
- **Release-mirror workflow failed on v0.1.6** with two underlying issues:
  1. `latest.json` is uploaded directly to GitHub by `tauri-action` and not left on disk, so the disk-pattern scan in the mirror step never found it. Fixed by downloading `latest.json` from the just-published private release into `RUNNER_TEMP` before re-uploading to the public mirror.
  2. The public mirror repo had no commits, so `gh release create` returned `HTTP 422: Repository is empty`. Fixed by seeding the public repo with a `README.md` (one-time, manual).
- The mirror step now uses two separate tokens — `GITHUB_TOKEN` to download from the private repo, `RELEASES_REPO_TOKEN` to upload to the public — and toggles `$env:GH_TOKEN` between calls.

## 0.1.6 — 2026-05-04

### Fixed
- **Auto-updater couldn't reach release JSON** because the source repo is private — GitHub does not serve release assets without auth, so the Tauri updater plugin's anonymous GET hit a 404 ("Could not fetch a valid release JSON from the remote"). Fixed by introducing a public mirror repo (`IP-Mattos/claude-startup-kit-releases`) that holds only the signed installers + `latest.json`. Source code stays private.

### Changed
- **Release pipeline mirrors signed assets to a public repo.** `release.yml` still builds and signs in the private repo, then a second step uses `RELEASES_REPO_TOKEN` (PAT with `Contents: Write` on the public mirror) to re-upload the `.msi`, `-setup.exe`, both `.sig` files, and `latest.json` to the public release tag. Idempotent — safe to re-run; uses `--clobber` and treats "already_exists" as a no-op.
- **`tauri.conf.json` updater endpoint** now points to `https://github.com/IP-Mattos/claude-startup-kit-releases/releases/latest/download/latest.json`. Anonymous, no auth needed, no rate-limits in practice for a single-machine user.

### Migration
- v0.1.0–v0.1.3 install: had no updater plugin, manual reinstall is unavoidable for those.
- **v0.1.4 / v0.1.5 install**: the updater is plumbed but points at the (private, 404-ing) old endpoint. **Manual install of v0.1.6 is required ONE more time** to land the new endpoint.
- **v0.1.6 onward**: the Tauri auto-updater fetches from the public mirror; subsequent versions install in-app with no manual step.

## 0.1.5 — 2026-05-04

### Added
- **Six new themes** in Settings → Theme — all built to the same standards as the existing eight (full token set + signature selectors per theme):
  - **AI Core** — near-black canvas with a 24px dot grid, hairline borders, phosphor-green prompt-line carets on hover. Mood: terminal-pure consciousness.
  - **Satellite** — deep navy mission-control with cyan accents, faint orbital coordinate grid overlay, calibration tick marks on stat-card hover.
  - **Unix '90** — flat steel CDE/Motif tiles, hard 1px hairlines, desaturated teal accent. The deliberate inverse of `chrome95`'s 3D bevels.
  - **Neural** — almost-black bio-interface with bioluminescent green halos on hover and amber axon-spark accents on rows.
  - **PS2 Glow** — brushed-aluminium gradient topbar with luminous cyan hairline; diffuse cyan underglow everywhere on hover.
  - **Blueprint** — drafting-paper deep blue with a 4-layer 10px/50px white-cyan grid, dashed construction-line focus outlines, dimension-bracket hover marks.
- **Resolvable audit findings** — every WARN / CRIT finding that the backend recognizes now carries an `action`, and the row gets a "Resolver" button that:
  - **Navigates** to the relevant tab for cleanup-style findings (`~/.claude > 5 GB`, large JSONLs).
  - **Opens** `settings.json` in VS Code for hook-timeout / risky-permission findings.
  - **Opens Explorer** for non-kit files in `lib/`.
  - **Kills the offending process** (with confirmation) for "PROCESSES > Xh" findings.
  - **Restores `settings.json`** from the most recent kit backup (with confirmation) when the JSON is invalid.
  - **Reinstalls the kit** (with confirmation) when no `.kit-version` marker exists.
  - All destructive actions go through `<ConfirmModal>`. New backend commands `kill_process`, `restore_settings_backup`, `reinstall_kit`. Mapping logic lives in Rust (`infer_action`) — the legacy `claude-audit.ps1` stays agnostic.

## 0.1.4 — 2026-05-04

### Added
- **Folder picker for clone target** — instead of typing the path by hand, the "Target directory" field in Sync now opens a real Explorer dialog via `tauri-plugin-dialog`. The text field is read-only display.
- **Live status while cloning** — each project row now shows a spinner with "Clonando…" during the in-flight `git clone` instead of a misleading red "Error · …" badge. New status `"cloning"` on the renderer-side `CloneResult`.
- **Confirm dialog before disk cleanup** — the "Limpiar todo" button in Cleanup now opens a `ConfirmModal` showing the count + total bytes about to be deleted, with a red `danger` button. No more accidental wipe on a single click.
- **Repo-name preview in sync setup** — the setup form now shows "Will create a private repo at github.com/`<gh user>`/`<name>`" using the authenticated `gh` user. New backend command `gh_username`.
- **Welcome card on first launch** — accent-tinted, dismissible Overview card with shortcuts to Sync setup and Settings. Persists `csk-onboarding-dismissed` in localStorage.
- **Autostart enabled on first launch** — to match the user's request that the app "open when the PC starts", the very first launch flips the launch-on-boot toggle on (gated by `csk-autostart-first-run-done` localStorage flag so we never re-enable on subsequent runs).

### Fixed
- **Project row name now matches the actual on-disk directory** — repos are cloned into `<targetDir>/<repo-from-URL>` instead of the optional display `name` from `projects.json`. This kills the "PolyMarket" row that pointed at `PolyTry.git` and produced a `PolyMarket/` folder unrelated to the repo. The display name is still shown as a small "alias: …" hint when it differs from the real repo name.
- **Dead `setError("target_required")` call removed** from `cloneOne` — the Clone button is already gated on `targetDir.trim()`, so the redundant guard fired into a place the user couldn't see anyway.

## 0.1.3 — 2026-05-03

### Added
- **"Update now" button in Settings** — both update channels (the app itself and `gentle-ai`) now expose an inline trigger right next to the version row. No need to wait for the top-of-page banner; if there's a newer release you can apply it whenever from Settings → Updates.
- **Launch on Windows boot** — new "Startup" card in Settings with a single toggle: "Launch Claude Startup Kit when Windows starts". Powered by `tauri-plugin-autostart`; persists to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Disabled by default — opt-in.

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
