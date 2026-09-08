# Gentle AI auto-sync after update

Date: 2026-09-07
Status: approved

## Problem

CSK can update the gentle-ai binary in two places: the update banner
(`apply_gentle_ai_update`) and "Update all" (`apply_stack_update`, Phase 2).
Both run the upstream installer, verify the version advanced, and return.
Neither runs `gentle-ai sync`, and the upstream installer never syncs either
(on Windows it is a `go install` wrapper). Result: the binary moves forward
while the managed Claude Code config in `~/.claude` stays at the version of
the last manual sync. gentle-ai's own `doctor` reports this as the
`installed:asset_version` warning.

Updates done outside CSK (manual `go install`) create the same drift and CSK
does not surface it at all.

## Decision

1. After a successful in-app update, CSK runs `gentle-ai sync` automatically.
2. For any drift, including updates done outside CSK, CSK shows a
   "config out of date" banner with a one-click sync.

Rationale: the user already clicked "update"; sync is the second half of the
same action. gentle-ai backs up before every sync, so the action is
recoverable. Banner-only in both cases was rejected (one extra click for no
safety gain).

## Constraints discovered

- `gentle-ai sync` does not remember the `--strict-tdd` or `--include-theme`
  flags between runs: a sync that omits them silently drops strict TDD or
  the theme. Both choices are visible on disk, though. Strict TDD is the
  managed block gentle-ai's sdd component writes into `~/.claude/CLAUDE.md`
  (`<!-- gentle-ai:strict-tdd-mode -->`, the line
  `Strict TDD Mode: enabled`, the closing comment; removed on uninstall).
  The theme is the marker file or folder under `~/.claude/themes/`. Every
  sync CSK triggers on its own reads both from disk and forwards them; the
  manual sync in the Gentle-AI tab keeps its explicit checkboxes.
- Drift signal: `~/.gentle-ai/state.json` field `installed_binary_version`
  (the version that produced the installed assets). `gentle-ai sync` rewrites
  it to the running version, so drift clears after a sync. Both sides are
  semver-normalized through the same `extract_semver` scraper the binary
  probe uses, so a suffixed value such as `2.7.0-rc.1` cannot create
  permanent drift.
- `gentle_ai_sync` passes no `--agent`, so it syncs every agent listed in
  `state.json` (`installed_agents`). The new paths keep that behavior.

## Backend (src-tauri/src/lib.rs)

Pure functions (unit tested, TDD):

- `gentle_ai_sync_args(strict_tdd, include_theme) -> Vec<&'static str>`:
  `["sync"]` plus `--strict-tdd` and/or `--include-theme`.
- `assets_out_of_date(installed_assets, running) -> bool`: false when either
  side is empty (mirrors gentle-ai doctor, which skips the check), otherwise
  exact string inequality.
- `parse_installed_assets_version(json) -> Option<String>`: reads
  `installed_binary_version`; `None` on invalid JSON, missing or empty field.
- `parse_strict_tdd_marker(claude_md) -> bool`: true only when the managed
  `gentle-ai:strict-tdd-mode` block exists and contains the exact line
  `Strict TDD Mode: enabled`.

Helpers:

- `read_installed_assets_version() -> Option<String>`: reads
  `~/.gentle-ai/state.json`, parses it and normalizes the value with
  `extract_semver`.
- `theme_installed() -> bool`: reuses the existing `theme` component probe.
- `strict_tdd_installed() -> bool`: reads `~/.claude/CLAUDE.md` through
  `parse_strict_tdd_marker`; false when unreadable.
- `run_gentle_ai_sync(program, strict_tdd, include_theme) -> Result<String, String>`:
  single place that spawns the sync, formats failures, busts the workspace
  summary cache and returns stdout. The existing `gentle_ai_sync` command is
  refactored onto it.
- `run_managed_sync() -> Result<String, String>`: the single owner of the
  preserve rule for every automatic sync: resolves the binary, reads both
  choices from disk and calls `run_gentle_ai_sync`.

Commands:

- `gentle_ai_sync_status() -> GentleAiSyncStatus { binary_version, assets_version, sync_needed }`
  (`assets_version` empty means unknown). It busts the gentle-ai resolution
  cache first so a binary installed outside CSK into another directory is
  seen.
- `gentle_ai_resync()`: busts the resolution cache, then `run_managed_sync()`.
  Used by the banner.
- `apply_gentle_ai_update() -> GentleAiUpdateOutcome { version, sync_error }`:
  after the existing version verification passes, run `run_managed_sync()`.
  Installer failures and a version that did not advance stay errors; a
  failed sync after a successful install is reported as `sync_error` on a
  successful outcome, never as a failed update. The drift banner offers the
  retry.
- `apply_stack_update() -> StackUpdateOutcome { log, sync_error }`: the
  upgrade (Phase 1 + 2) runs as one blocking task with a single success exit
  that also reports whether the gentle-ai binary advanced. One post-step then
  runs `run_managed_sync()` when the binary changed or
  `assets_out_of_date(...)`, appending the sync output to the log. A sync
  failure travels as `sync_error` (short, without the log).

Both new commands are registered in `generate_handler!`. The capability
allowlist needs no change: custom commands are covered by `core:default`.

## Frontend

- `src/lib/useUpdates.ts`: `refreshSyncStatus()` is the single owner of the
  `gentle_ai_sync_status` probe. `runChecks` calls it, and a listener for
  the window event `csk:gentle-ai-synced` re-runs it so every hook instance
  (AppV3, Overview, Settings) shows the same drift state. A probe failure
  clears the banner and surfaces through `gentleAiError` (backend failures
  never masquerade as empty states). `applyGentleAi` always re-checks after
  the IPC resolves and stores `sync_error` in `gentleAiSyncError`.
  `resync()` runs `gentle_ai_resync`, then only the drift probe (no GitHub
  calls) and dispatches `csk:workspace-invalidate` and
  `csk:gentle-ai-synced`.
- `src/lib/useStackUpdates.ts`: reads `StackUpdateOutcome`; always
  re-checks and dispatches both events after the IPC resolves; `sync_error`
  is exposed as `syncError` and rendered by `SettingsView` through
  `stack.sync_failed`.
- `src/views/v3/ClaudeView.tsx`: dispatches `csk:gentle-ai-synced` after a
  successful manual sync. Its Strict TDD checkbox stays as it is.
- `src/v3/AppV3.tsx`: a "config out of date" banner using the existing
  update-banner classes, rendered whenever `sync_needed` is true except while
  a gentle-ai update is being applied. It shows `resyncError` on a failed
  resync and `banner.gentle_updated_sync_failed` when the last update
  installed but its sync failed. The banner disappearing is the success
  feedback.
- `src/lib/i18n.ts`: `banner.gentle_sync_needed`, `banner.gentle_sync_now`,
  `banner.gentle_updated_sync_failed` and `stack.sync_failed` in English and
  Spanish; the syncing state reuses `claude.syncing`.

## Testing

Strict TDD for the four pure functions: failing tests first inside the
existing `mod tests`, then the implementation. The frontend has no test
runner; UI logic stays thin and is verified with `pnpm typecheck`.

## Out of scope

- Persisting the Strict TDD or theme choices in CSK (the disk probes are
  enough).
- Any change to gentle-ai itself.
- Release/tag: follows the usual two-commit ritual, triggered separately.
