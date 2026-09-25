# Pi stack installer

## Objective

Let the Pi panel install the stack it reports on, so a machine without Pi goes from "everything missing" to a working install without the user running three commands by hand.

## Problem

The panel shipped in v0.1.122 reports correctly and stops there. On a second machine it renders every row as missing — which is accurate, and is also the first confirmed runtime evidence that the panel works — but the user is then left to reconstruct the install by hand.

The sequence is not guessable, and its third step is the one nobody finds:

1. `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` — the Pi runtime. `gentle-ai install --agent pi` does NOT install it, and the old `@mariozechner/pi-coding-agent` package is deprecated.
2. `gentle-ai install --agent pi` — gentle-pi and its companions.
3. `node scripts/install-gentle-ai.mjs` inside the gentle-pi package root — builds the pinned `gentle-ai` binary. npm's `ignore-scripts=true` silently skips the postinstall that normally does this, and every gentle-pi upgrade re-pins a version that needs rebuilding again.

## Why

Step 3 is invisible: nothing fails at install time, and Pi only breaks later. A machine that ran steps 1 and 2 looks installed and is not. The panel already knows how to detect exactly that, so it is the right place to fix it.

## Scope

An install action in the Pi panel. The user chose: **one button for the base stack, with the Claude provider as an additional opt-in**, rather than bundling the provider or splitting one button per row. The provider needs Claude Code logged in on that machine, so it must not be forced.

Out of scope: uninstall, upgrade-in-place, and flagging conflicting packages.

## Constraints

- Branch `feat/pi-stack-installer`, cut from `desktopapp` at `a8cfcc0`.
- Repo rules (CLAUDE.md): blocking IO inside `tokio::task::spawn_blocking`; external CLIs through `silent_command()`; commands registered in `generate_handler!`; all copy through `useT()` in `en` and `es`; Conventional Commits with no AI attribution.
- **Never run `pnpm build` or `cargo build`.**
- On Windows `npm` and `pi` resolve to `.cmd` wrappers that `Command::new` cannot spawn directly — the existing code already deals with this and the new code must reuse that approach.
- Receipt-driven development is disabled clone-local for this repo, so no review consent is relayed for these commits.

## Authorized scope

`src-tauri/src/lib.rs`, `src/views/v3/PiView.tsx`, `src/lib/i18n.ts`, and this document.

## TDD

Strict TDD is enabled. Runner: `cargo test --locked` in `src-tauri/`. Observed RED before implementing. The step plan is the testable seam: given resolved executables and the opt-in flag, it returns the ordered commands to run, without spawning anything.

## Tasks

- [x] **T1 — `install_pi_stack` command.** Route: delegated writer. Takes the provider opt-in as an argument, runs the three base steps in order plus the optional fourth, and returns a per-step result (name, ok, and the tail of its output) instead of a bare error, so the UI can show which step failed. A failing step stops the sequence: step 3 is meaningless if step 2 did not produce a gentle-pi root. Missing `npm`, `node` or `gentle-ai` fails with a message naming what is missing.
- [x] **T2 — Install action in the panel.** Route: delegated writer. A button with the opt-in for the Claude provider, pending state while it runs, the per-step result rendered afterwards, and a refresh of the status when it finishes. Copy in `en` and `es`.

- [ ] **T3 — Claude Code as an opt-in install step.** Route: delegated writer. Added after v0.1.123, from evidence on the user's second machine: the panel reported `claude --version failed or claude not found`, which is accurate and leaves the user stuck, and the Claude provider is useless without it. A second opt-in, independent of the provider one, runs Anthropic's documented Windows installer `irm https://claude.ai/install.ps1 | iex` as the FIRST step, before the Pi stack, so the later provider step can find it. Two things this cannot do, and the copy must say so: it does not log you in — that is interactive, `claude` in a terminal — and the provider also needs Claude Code at 2.1.281 or newer.

## Acceptance criteria

- On a machine with Pi missing, the action installs it and the panel's rows flip from missing to ok after the refresh.
- Re-running it on this machine, which is already installed, is harmless.
- With the opt-in off, `pi-claude-code-provider` is not installed.
- A failure in any step is visible and names the step, instead of surfacing as a generic error.
- `cargo test`, `cargo clippy -D warnings` and `pnpm typecheck` pass.

## Checks

`cd src-tauri && cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `pnpm typecheck` at the repo root.

## Delivery

Strategy: `ask-on-risk`. One work-unit commit per task. Push, PR and release remain the user's decision.

## Progress

- Branch created from `desktopapp` (`a8cfcc0`, the v0.1.122 release commit).
- Runtime evidence carried over from the previous feature: the panel renders and reports correctly on a machine with nothing installed. The all-ok path is still unconfirmed.
- **T1 and T2 done.** Observed RED first (`cannot find function \`build_install_pi_stack_steps\` in this scope`, four call sites), then GREEN. `cargo test --locked` → 97 passed, `cargo clippy --locked --all-targets -- -D warnings` → clean, `pnpm typecheck` → exit 0, all re-run as parent spot checks. Verified by reading the plan that step 1 keeps `--ignore-scripts` and step 3 carries `dir: Some(gentle_pi_root)`. Step 4 resolves `pi` only after steps 1–3 succeed, because `pi` does not exist to resolve on a fresh machine.
- **Never executed.** The install sequence has not been run, here or anywhere: no global npm install, no `gentle-ai install`, no postinstall, no provider install, and the button has not been clicked. Every acceptance criterion that needs a real run is still open.
- Next step: run it on a machine that actually lacks Pi.
