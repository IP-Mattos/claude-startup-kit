# Audit Report — Pass 4 (4 parallel agents)

Date: 2026-07-03
Branch: `desktopapp` (v0.1.117)
Scope: repository root (Tauri 2 + React 19 + Vite) plus `tools/claudewatch/` (Go TUI) and `src-tauri/src/trello/`.

This report consolidates findings from four focused agents (security, performance, a11y/UX, code/architecture). Line numbers were verified on 2026-07-03; concurrent fixes on `desktopapp` may shift them slightly.

## Pass-3 status

The pass-3 backlog (2026-05-02) is essentially cleared:

- Theme `@import` chain replaced with lazy `import.meta.glob` loading + per-theme `manualChunks` ([src/lib/themes.ts](src/lib/themes.ts), `vite.config.ts`).
- `AppV3.tsx` split from 1055 to ~474 lines — views promoted to `src/views/v3/`, shared components to `src/components/v3/`.
- `AuditFinding` boundary validator added ([src/lib/audit.ts](src/lib/audit.ts)).
- Fetch errors surfaced via retry banner; `role="alert"` on error surfaces.
- V1 layout (`src/App.tsx`), `src/v3/views.tsx`, and the `cskLayout` backdoor deleted.
- Theme catalog cut down to the 8 curated themes that remain under `src/v3/themes/`.

## Fixed in the batch landing with this report (2026-07-03)

- Update-cooldown state loss on remount ([src/lib/useUpdates.ts](src/lib/useUpdates.ts), [src/lib/useStackUpdates.ts](src/lib/useStackUpdates.ts)) — last check results cached in `localStorage`, hydrated within the 24h cooldown.
- Base-CSS contrast tokens (`--v3-crit-ink`, `--v3-accent-ink`, `--v3-focus-ring`, etc.) so themes stop inheriting failing ink colors.
- CI: `cargo test`, `cargo clippy -D warnings`, Go build/test for claudewatch, plus Dependabot (`.github/workflows/ci.yml`, `.github/dependabot.yml`).
- `toggle_mcp_server` name validation (`validate_mcp_name` in `src-tauri/src/lib.rs`).
- `write_text_file` export-path confinement (`validate_export_path`: extension allowlist, canonicalized parent, autostart-dir rejection).
- Absolute CLI resolution (`resolve_cli`) to close PATH-shadowing on shelled binaries.
- Release `tag_name` validation before the gentle-ai `irm | iex` installer runs.
- `claude_code_status` made async (`spawn_blocking` around the subprocess probes).
- Mutex-poisoning hardening (`KNOWN_PROJECTS_CACHE` and friends now recover via `unwrap_or_else(into_inner)`).
- CSP: `base-uri` / `form-action` / `frame-ancestors` added; localhost origins moved to `devCsp` (`src-tauri/tauri.conf.json`).
- CleanupView "…and N more" replaced with a per-category Show all / Show less expandable list.
- Unused `@fontsource/jacquard-12` + `@fontsource/bitter` imports removed from `src/main.tsx` (the packages themselves still sit in `package.json` — drop them with a lockfile update in a follow-up).
- StatusBar shows the real app version (`src/components/v3/StatusBar.tsx`).
- AuditView i18n headers + stable finding keys.

---

## Security

### CRIT
- **`src-tauri/src/trello/storage.rs:8` — Trello bearer token stored in plaintext on Windows**: `~/.claude/trello.json` gets `0600` on Unix, but Windows ACLs are not tightened — the module's own TODO says "migrate secrets to tauri-plugin-stronghold or platform keyring". Fix: DPAPI (`CryptProtectData`) or a keyring crate; plaintext fallback only with explicit user consent.

### WARN
- **`src-tauri/capabilities/default.json:19` — `opener:default` capability**: grants the renderer generic open-URL/open-path ability, bypassing the curated `open_url` command (rundll32 + validation). Remove or scope it; route all opens through the audited Rust commands.
- **`src-tauri/src/lib.rs:2896` — `open_path_in_explorer` launches executables**: `validate_open_path` accepts any existing path; `explorer.exe <path>` on an `.exe` runs it. Require `canonical.is_dir()` (or open the parent + select for files).
- **`src-tauri/src/lib.rs:2999` — `fix_claude_vscode_extension` predictable temp script name**: writes `csk-fix-claude-vscode-{unix_seconds}.ps1` to the shared temp dir and executes it — name is guessable within the second (symlink/pre-creation squat on multi-user machines). Use `tempfile` with a random suffix + exclusive create.

### SUG
- **`src-tauri/src/lib.rs:2723` — claudewatch binary sync compares size, not hash**: `install_claudewatch_resources` treats equal file length as "same build"; two different builds of identical size skew the launcher/binary pair. Compare a SHA-256 (or embed a version resource).

---

## Performance

### WARN
- **Zero `React.memo` app-wide**: the Topbar wall clock ticks every 1s ([src/components/v3/Topbar.tsx](src/components/v3/Topbar.tsx)) and AppV3's 30s "X ago" tick re-render their subtrees; nothing memoizes below them. Start with `Sidebar`, `CompanionWidget`, and the view roots.
- **Three independent `useUpdates()` instances** — `src/v3/AppV3.tsx:109`, `src/components/v3/OverviewView.tsx:413`, `src/views/v3/SettingsView.tsx:60`: three state copies, three cooldown reads, potential duplicate checks. Unify into a single store/context provided once from AppV3.
- **Tab-switch unmounts re-fire IPC**: Conversations / Trello / Claude / Cleanup fetch on mount, and ProjectsView mounts `GhReposCard`, which shells `gh` (`gh_list_repos`) plus a disk git-repo scan on every Projects visit. Add a session-scoped cache or lift results, mirroring the Rust-side 5-min engram cache.

### SUG
- **Version bump is manual across 4 files** (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, lockfile). `tauri.conf.json` can inherit `"version": "../package.json"`; a bump script closes the rest.

---

## Accessibility & UX

### CRIT
- **Zero `aria-pressed` / `aria-current` app-wide**: active tab (Sidebar/Topbar), filter chips, and toggle buttons expose no state to assistive tech — `rg aria-pressed|aria-current src` returns nothing.

### WARN
- **Trello modals lack a focus trap**: `TaskEditor`, `TaskImportModal`, `TaskExportModal` let Tab escape to background controls while `aria-modal` claims otherwise. [src/components/v3/ConfirmModal.tsx:72](src/components/v3/ConfirmModal.tsx) already implements the correct trap — extract it into a shared hook.
- **`src/components/v3/CommandPalette.tsx:149` — engram search fails silently**: `engram_search_to_file` failure only hits `console.warn`; the user sees nothing happen. Also the palette list lacks `role="listbox"` / `role="option"` + `aria-activedescendant` semantics.
- **`src/components/v3/GhReposCard.tsx:142` — target-dir input not programmatically labeled**: the `.v3-form-label` is a bare `<span>` next to the `<input>` — no `htmlFor`/`id`, no `aria-label`.
- **No `:disabled` styling** for `v3-btn-ghost`, `v3-link`, icon buttons, or chips — disabled controls look enabled and read as broken when clicked.

### SUG
- **`--v3-text-4` used as a text color** (~40 uses in `AppV3.css`): the faintest tier fails WCAG AA as foreground text on several themes. Reserve it for decorative elements or bump per-theme values.

---

## Code Quality

### WARN
- **Hardcoded Spanish strings in Rust** (`src-tauri/src/lib.rs:2734`, `:2738`, and the `MIRROR_LAG` message in `apply_app_update`, among others): error messages surface verbatim in an EN/ES-i18n'd frontend. Return stable error codes and translate in `src/lib/i18n.ts`, or default Rust messages to English.
- **3 unused JS dependencies** — `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, `@tauri-apps/plugin-opener` (`package.json:19–21`): no imports under `src/`; the updater/opener run entirely Rust-side. Drop them from the frontend bundle.

---

## Infra

### WARN
- Release notes body in `.github/workflows/release.yml` pointed at a `CHANGELOG.md` that stopped at 0.1.52 — fixed alongside this report (now points at auto-generated GitHub release notes / commit history).

### SUG
- Residual i18n polish: AuditView headers (in the current batch) and the Rust-side messages above are the last hardcoded-copy holdouts.

---

## Recommended next slice (high-value, low-risk)

1. Trello token → DPAPI/keyring (security CRIT, isolated in `trello/storage.rs`).
2. Remove/scope `opener:default` from `capabilities/default.json`.
3. Extract ConfirmModal's focus trap into a hook; apply to the three Trello modals.
4. `aria-pressed` / `aria-current` pass over Sidebar, Topbar, and filter chips.
5. Unify `useUpdates()` into a single store; fixes duplicate checks and simplifies the cooldown-state work already in flight.
6. `open_path_in_explorer`: require `is_dir`.
7. Hash-based claudewatch binary sync + version single-sourcing (`tauri.conf.json` ← `package.json`).

Everything else compounds on these — do the security items first, they're small and self-contained.
