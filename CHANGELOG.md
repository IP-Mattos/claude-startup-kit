# Changelog

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
