# Changelog

## 1.3.2 — 2026-04-28

### Improvements
- **Verbose `check-gentle-ai.sh` logging** so the kit log records every upgrade event — not just hook fired/skipped. New log entries:
  - `INFO Installed version: vX.Y.Z` (every check)
  - `INFO Latest release: vA.B.C` (every check that reaches GitHub)
  - `WARN Could not reach GitHub API (network/rate-limit?)` (offline / API blocked)
  - `WARN gentle-ai not installed on PATH` (corner case)
  - `INFO Up to date (vX.Y.Z). No action.`
  - `INFO Update available: vX.Y.Z → vA.B.C. Running PowerShell installer...`
  - `INFO UPGRADED vX.Y.Z → vA.B.C (target was vA.B.C)` ← the "did it actually update?" line you can now grep
  - `ERROR Upgrade FAILED (vX.Y.Z → vA.B.C)`
- Now you can run `grep UPGRADED ~/.claude/logs/startup-kit.log` to see your full upgrade history per machine.

## 1.3.1 — 2026-04-28

### Fixes (caught by integration test)
- **"41" stray output bug**: a value (the visible length of the gentle-ai status line) was leaking to stdout between the header and "Ayer hiciste" sections, and again before the footer. Root cause was `if ($x -lt N) { $x = N }` patterns in PowerShell that occasionally emit the assigned value when at script-statement level. All 4 occurrences converted to `$x = [math]::Max(N, $x)`, which is idiomatic and never leaks. Bonus: renamed `$hr` to `$rule` since `hr` is short enough that PowerShell can confuse it in some parses.
- **`startup-kit-config.json` parse error**: the user config kept emitting `Exception setting "_repoPath_help": ...` because the config loader was trying to copy every key from user config to defaults, including the `_help`-style documentation keys that don't exist on the defaults object. Fixed: `Get-StartupKitConfig` now skips keys starting with `_` AND skips any key the defaults don't already declare.
- **`Window resize failed: BufferSize too large`**: the buffer height was forced to `max(lines, 3000)` which exceeds the Windows console host's MaxPhysicalWindowSize on some configurations. Now caps at 9999 and respects MaxPhysicalWindowSize for both buffer and window dimensions, with a sane fallback if the host doesn't report it.
- **`.kit-version` desfasado**: re-running `install.ps1` syncs it to the current `VERSION`. (No code change — just `install.ps1` always writes the marker on success, which it already did. Just needed a re-run.)

## 1.3.0 — 2026-04-24

### Visual redesign — clean over decorative

The v1.1/v1.2 cyberpunk HUD layout was found "raro / cargado / no óptimo" by the user. Two reviewer agents (an Explore review of the rendered output + a frontend-design redesign proposal) agreed: the layout had too many fake status indicators, redundant labels, duplicated sections, and conflicting colors. This release replaces it with a calm, single-language layout.

**Removed**:
- 3 stat tiles with 6 lines each (`MODULE/VERSION/STATE/MODE/INTERVAL/CHANNEL` per tile) — most of it decorative.
- Auto-generated `NODE-XXX-YY` codes per project — duplicated the project name.
- `ARCHIVE_LOG :: AYER_EN_RESUMEN` / `NODE_INDEX :: PROYECTOS_ACTIVOS` ALL-CAPS section titles — visually loud.
- Fake HUD indicators: `SIGNAL STRONG`, `AUTH gh OK`, `[scan ok]`, `MCP active`.
- `PATH ` label before the actual path (the path itself was already there).
- 2-line footer with verbose `>> CMD::` / `>> SYS::` keybinding docs.
- Session ID + KIT version + ts header strip.
- Side-by-side card layout — was making things harder to scan, not easier.
- Dead lib helpers: `New-Card`, `New-StatTile`, `New-NodeCode`, `New-SessionId`, `Format-SideBySide` (no longer called).

**Kept / improved**:
- Header: ONE line with title + date · gentle-ai status · optional PR count.
- "Ayer hiciste": only projects with activity in last 48h, with Engram goal + last commit (`└` connector).
- "Proyectos activos": clean numbered list `★ [01] Name  path  hoy/ayer/Nd`. Star marks pinned, day-tag is right-aligned.
- Footer: ONE line with all keybindings.
- Three accent colors only: cyan (project names), green (hoy), yellow (★ + cursor + warnings).

The redesign was driven by independent agents — the model didn't pick the design, the reviewers did.

## 1.2.0 — 2026-04-24

### Features
- **Adaptive sizing** (`window.adaptive: true` by default): the brief now detects the primary monitor's working area and computes window cols/lines and font size automatically. Works across HD (1366x768), FHD (1920x1080), 2K (2560x1440), and 4K (3840x2160) screens. DPI scaling is respected (Windows reports the post-scaling working area). Set `window.adaptive: false` to lock to the literal `cols`/`lines`/`fontSize` values in config.
- New module: `scripts/lib/screen-adapt.ps1` (`Get-AdaptiveDimensions`) — returns dimensions based on screen ratios + Consolas character cell metrics, clamped to sane min/max bounds.
- Window resize is applied at runtime via the PowerShell host's `RawUI.BufferSize`/`WindowSize`, capped at `MaxPhysicalWindowSize` to avoid throwing on small screens.

### Calibration

| Screen | Working area (typical) | Adaptive output |
|--------|------------------------|-----------------|
| 1366x768  | ~1366x728 | 100x24 @ 12px |
| 1920x1080 | ~1920x1040 | 130x32 @ 15px |
| 2K (2560x1440) | ~2560x1392 | 153x38 @ 20px |
| 4K (3840x2160) | ~3840x2112 | 156x42 @ 28px (font capped) |

Adjust the ratios or clamps in `lib/screen-adapt.ps1` if you want different proportions.

## 1.1.0 — 2026-04-24

### New features
- **Self-update detection**: brief detects when the cloned kit repo is behind `origin/main` and shows a banner. Type `u` at the prompt to `git pull --ff-only && install.ps1` automatically.
- **Quick actions per project**: `N` = open VS Code (default). `N t` = terminal at the project. `N g` = `git status -sb`. `N l` = `git log --oneline -10 --graph`. `N e` = explorer. `N c` = copy path to clipboard.
- **Pinned projects**: list project folder names under `pinned` in config; they appear first regardless of activity date, marked with `*`.
- **Recent commit per project** in AYER EN RESUMEN (when project is a git repo): hash + subject + relative time + author, alongside the Engram summary.
- **Themes**: `default`, `dracula`, `solarized`, `nord`, `monochrome`. Set via `theme` in config.
- **Keyboard shortcuts**: `q` to quit, `r` to refresh, `u` to self-update.
- **Splash screen** during slow init so the user sees something while modules + Add-Type compile.
- **GitHub PR queue**: optional section showing PRs awaiting your review (uses `gh search prs --review-requested=@me`). Toggle with `github.showPrQueue` in config.
- **`health-check.ps1`** standalone command: validates dependencies, scripts presence, BOMs, hooks in settings.json, user-custom blocks in CLAUDE.md, Startup folder shortcut, log freshness, and version marker. Prints a colored status table.
- **`standup.ps1`** standalone command: generates a markdown standup from Engram session-summary Goals + git's last commit per active project. Pipe to `Set-Clipboard` to paste anywhere.

### New modules in `scripts/lib/`
- `themes.ps1` — color presets
- `git-recent.ps1` — last commit info per project
- `github-prs.ps1` — `gh` CLI wrapper for PR queue
- `self-update.ps1` — detect + apply kit updates

### Config additions
- `theme`, `pinned[]`, `git.showRecentCommitInBrief`, `github.showPrQueue`, `github.prLimit`, `selfUpdate.checkOnStart`, `selfUpdate.repoPath`.

### Installer / CI
- Installer copies new lib + standalone scripts and ensures BOM on each.
- Help banner at the end of install lists all features and standalone commands.

### Not in this release (deliberately)
- Google Calendar / meetings integration: requires user-side OAuth setup in Google Cloud Console.
- Cross-platform Mac/Linux rewrite (Go/Rust): tracked as a separate larger effort.
- Choco/Scoop publishing: tracked as a separate effort.
- Pomodoro timer: not adding by request.
- Claude API integration for AI suggestions: not adding by request.

## 1.0.0 — 2026-04-24

Initial release: gentle-ai auto-update, daily brief in Claude Code, Windows startup launcher, idempotent installer, file-based logs, modular `lib/`, native PS scan, real Engram session-summary integration, GitHub Actions CI.
