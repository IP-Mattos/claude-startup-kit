# Pi stack health panel

## Objective

Add a `pi` tab to CSK that reports the health of the local Pi / gentle-pi stack, the same way the `claude` tab reports the gentle-ai stack.

## Problem

CSK has zero awareness of Pi (verified: no match for `gentle-pi`, `~/.pi`, `pi-agent` anywhere in the repo). Three failures hit this machine in one week, and every one of them is invisible until something breaks at runtime:

1. `ignore-scripts=true` (deliberate supply-chain hardening) silently skips gentle-pi's postinstall, so its pinned `gentle-ai.exe` is never built. Nothing reports the gap.
2. A gentle-pi upgrade re-pins a new gentle-ai version, so the binary must be rebuilt again after every upgrade.
3. Installing `@juicesharp/rpiv-ask-user-question` collides with gentle-pi's own `ask-user-question` extension and Pi then refuses to load every extension.

## Why

The data already exists on disk (`~/.pi/agent/settings.json`, the package's `.gentle-ai/` folder, `pi`/`claude` version output). Reading it costs nothing and turns a runtime breakage into a visible status row.

## Scope

In scope for this feature: a read-only status panel (Rust command + React view + i18n).

Out of scope for now, tracked for later slices: remediation actions (rebuild the binary, uninstall a conflicting package), npm latest-version lookups, and Pi session usage/cost reporting.

## Constraints

- Branch `feat/pi-stack-panel`, cut from `origin/desktopapp`. PRs target `desktopapp`.
- Repo rules (CLAUDE.md): blocking IO inside `tokio::task::spawn_blocking`; external CLIs through `silent_command()`; every new `#[tauri::command]` registered in `generate_handler!` AND allowlisted in `src-tauri/capabilities/default.json`; all user-facing copy through `useT()` (en + es); Conventional Commits with no AI attribution.
- **Never run `pnpm build` or `cargo build`.**
- T1 stays offline: filesystem and local CLI version output only, no network.

## Authorized scope

`src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src/views/v3/`, `src/components/v3/`, `src/constants/v3Nav.ts`, `src/v3/v3types.ts`, `src/v3/AppV3.tsx`, `src/lib/i18n.ts`, and this document.

## TDD

Strict TDD is enabled. Runner: `cargo test --locked` in `src-tauri/`. Source: global configuration. Observed RED is required before implementing each Rust behavior. The frontend has no JS test runner; it is verified with `pnpm typecheck`.

## Tasks

- [x] **T1 — Rust `pi_stack_status` command.** Route: delegated writer (2+ non-trivial files). Returns Pi version and path, Claude Code version, installed gentle-pi version and root, the pinned gentle-ai version with its expected binary path and whether that binary is present, and from `~/.pi/agent/settings.json` the default provider, default model, TUI mode and package list. Per-source failures are collected into an `errors` vector instead of failing the whole command. Pure parsers (version output, `INSTALLER_VERSION` from `scripts/gentle-ai-installer.mjs`, settings JSON) are unit tested; no test touches the real filesystem.
- [ ] **T2 — `pi` tab in the UI.** Route: delegated writer. New `PiView.tsx` modelled on `ClaudeView.tsx`, a `pi` entry in `V3Tab` + `TOPBAR_NAV`, wiring in `AppV3.tsx`, and en/es i18n keys. Shows each row with an explicit ok / missing / unknown state, and names the fix in the copy when the binary is missing.

## Acceptance criteria

- The command returns a populated status on this machine, including `gentle_ai_binary.present = true` for the currently installed v3.7.0 build.
- Removing or renaming the binary flips that row to missing without erroring the command.
- A malformed or absent `~/.pi/agent/settings.json` yields an entry in `errors` and leaves the rest of the payload intact.
- `cargo test`, `cargo clippy -D warnings` and `pnpm typecheck` all pass.

## Checks

`cd src-tauri && cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `pnpm typecheck` at the repo root.

## Delivery

Strategy: `ask-on-risk`. Forecast about 450 authored changed lines across T1 and T2, so the ~400-line budget is likely to be crossed; ask once before opening a pull request. One work-unit commit per task. Push, PR and merge remain the user's decision.

## Progress

- Branch `feat/pi-stack-panel` created from `origin/desktopapp` (d356808).
- **T1 done.** `src-tauri/src/lib.rs` +500/-6. Observed RED first: 24 compile errors naming the missing parsers (`cannot find function \`parse_installer_version\` in this scope`, and the same for the other five), then GREEN. Verified by the writer and re-run as a parent spot check: `cargo test --locked` → `90 passed; 0 failed` (7 match the `pi_` filter, 83 pre-existing); `cargo clippy --locked --all-targets -- -D warnings` → clean.
- **Two deviations from the task brief, both accepted with evidence.** (a) The structs are snake_case, not camelCase: the neighbouring `ClaudeCodeStatus` and `GentleAiStatus` carry no `rename_all`, and `ClaudeView.tsx` reads `status.cli_version` directly, so camelCase would have been the inconsistent choice. (b) `capabilities/default.json` was left untouched: it lists only core and plugin permission identifiers, and none of the ~40 existing app commands appear there, so a fabricated `allow-pi_stack_status` entry would be wrong. CLAUDE.md line 52 overstates this — worth correcting in a separate change, out of scope here.
- **Not yet verified:** the command has never been invoked at runtime, because that needs `pnpm tauri dev`. The acceptance criteria that depend on a live call stay open until T2 puts the tab on screen.
- Next step: T2.
