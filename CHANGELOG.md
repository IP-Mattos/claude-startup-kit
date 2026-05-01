# Changelog

## 2.7.1 — 2026-05-01

### Fix: every letter command (`t`, `r`, `a`, `x`, `l`, `c`, `?`, `u`) printed `Formato invalido` after running
Caught while testing `t`. After cycling the theme, the brief was rendering the menu correctly but then printing `Formato invalido. Tipea N, "N letra" (t/g/l/e/c), o "p#" para fijar.` right above the next prompt — making it look like the command had failed even though it had actually worked.

**Root cause**: in PowerShell, `continue` inside a `switch` block only exits the switch, **not** the enclosing `while` loop. After the switch ended, execution fell through to the `/<query>` / `s N` / `pN` / numeric-pattern checks below, eventually hitting the catch-all "Formato invalido" message because no pattern matched a single letter.

**Fix**: introduced a `$handled = $false` flag at the top of the prompt loop. Each letter case in the switch now sets `$handled = $true` instead of calling `continue`. Right after the switch, `if ($handled) { continue }` cleanly skips the regex section. 9 cases converted (`r`, `t`, `c`, `?`, `u`, `a`, `x`, `l`, plus the pin-toggle and snooze paths).

Tested: typing `t` now cycles theme, persists to config, re-renders the menu, prints `Tema: <new>`, and goes straight to the next prompt — no spurious error.

## 2.7.0 — 2026-05-01

### Search/filter + Snooze
Two new commands at the prompt to handle a long project list without scrolling.

**`/<query>`** — filter the menu live
- `/poly` shows only projects whose folder name OR full path contains `poly` (case-insensitive)
- `/` (just the slash, empty query) clears the filter
- Filter is applied in-memory; doesn't touch any state file

**`s <num> <days>`** — snooze a project
- `s 3 7` hides project #3 from the menu for 7 days
- Persists to `~/.claude/scripts/.snoozed.json` with the unsnooze timestamp
- Snoozed projects come back automatically when the date passes (reads on every brief launch)
- Project's data is untouched — this is purely a menu visibility filter

**`s show`** — list everything currently snoozed with the date it returns

### Footer + help screen
Footer now reads:
`número para abrir · p# fijar · /q filtrar · t tema · a audit · x cleanup · l log · c config · ? ayuda · q salir`

The `?` help screen has a new "Pinned / Snooze / Filter" section grouping the three together with usage examples.

### State files
- `.snoozed.json` — `{"projectname": "2026-05-08T17:00:00..."}` mapping. Cleaned automatically when entries expire.

## 2.6.0 — 2026-05-01

### Toast/dialog alert when audit finds CRIT
The brief was already showing an inline alert banner above the menu when the auto-audit detected CRIT/WARN. But that only helps if you actually open the brief. v2.6.0 adds a **Windows MessageBox dialog** that pops up automatically right after the auto-audit completes, when:

1. Auto-audit ran (24h guard passed → it ran)
2. CRIT count > 0
3. The CRIT count differs from what we last alerted on (idempotent — no spam)

The dialog lists the CRIT finding titles and tells you to open the brief and type `a` for details. It's modal but only fires on transition: if you ignore it, you'll see it again only when the count *changes*. If the audit goes back to clean, the alert state resets so future CRIT counts trigger a fresh dialog.

**State files** (in `~/.claude/scripts/`):
- `.audit-summary.json` — counts + findings (already there since 2.3.0)
- `.audit-alerted-crit` — last CRIT count we've alerted on (NEW)

**Why a MessageBox and not a real Windows toast?** This is Win11 Enterprise LTSC; native toasts (`BurntToast`, AppUserModelID-based) are unreliable on this edition. MessageBox is uglier but works 100% of the time.

## 2.5.0 — 2026-05-01

### Deeper audit checks
Added 6 new categories to `claude-audit.ps1`:

| Category | Check |
|----------|-------|
| **DRIFT** | Existence of `~/.claude/settings.local.json` (overrides settings.json — flagged as WARN) |
| **ENV** | Environment vars matching `CLAUDE_*` / `MCP_*` / `ANTHROPIC_*`. Values containing `KEY`/`TOKEN`/`SECRET` are redacted in output |
| **DRIFT** (plugins) | Plugins in `enabledPlugins` whose marketplace isn't declared in `extraKnownMarketplaces` — WARN |
| **DISK** (big JSONLs) | Single Claude Code session JSONLs > 100 MB. Suggests running `cleanup.ps1` |
| **HOOKS** (timeouts) | Hooks configured with `timeout > 300s` — WARN. Long timeouts can be used to keep daemons alive past their welcome |
| **STARTUP** | Lists everything in Windows Startup folder (`shell:startup`). Annotates the kit's own launcher |

These shore up the realistic threat model — drift detection, not malware. With these, the audit catches: a sneaky `settings.local.json` override, env var injection, plugins from unknown sources, single-session bloat, hook timeouts that look like persistence mechanisms, and unexpected startup-folder entries.

## 2.4.0 — 2026-05-01

### New: `cleanup.ps1` — disk cleanup utility
A standalone tool plus `x` shortcut in the brief that handles the storage growth problem (`~/.claude/projects/` was already at 345 MB on the dev machine).

**What it cleans** (anything older than `-OlderThanDays`, default 30):
- **`logs/`** — old log files (preserves `startup-kit.log` itself; truncates it to last 1000 lines if > 5 MB)
- **`backups/`** — pre-install backups left by the kit installer
- **`projects/<name>/*.jsonl`** — old Claude Code session transcripts (these are the real disk hog)

**Modes**:
- `cleanup.ps1` — interactive: shows preview, asks before deleting
- `cleanup.ps1 -DryRun` — preview only, no changes
- `cleanup.ps1 -Yes` — non-interactive
- `cleanup.ps1 -Logs` / `-Backups` / `-Projects` — limit to one category
- `cleanup.ps1 -OlderThanDays 60` — different threshold

**Output**: per-category breakdown with file counts and MB, plus a summary line. Color-coded (cyan section heading, white sizes, gray timestamps).

### `x` shortcut in the brief
Type `x` to run the cleanup in `-DryRun` mode (preview-only, can't accidentally delete from inside the brief). To actually delete, run the standalone script with confirmation.

### Install + audit updates
- `install.ps1` and the health-check whitelist now include `cleanup.ps1`.
- `claude-audit.ps1`'s SCRIPTS whitelist also includes `cleanup.ps1` so it doesn't flag itself as foreign.

## 2.3.0 — 2026-05-01

### Auto-audit + alert banner
- The brief now runs `claude-audit.ps1 -Summary -NoNetwork` automatically once per 24h on launch. Adds ~300-500ms but only the first time of the day; subsequent launches read the cached `.audit-summary.json`.
- New `-Summary` mode in `claude-audit.ps1`: writes a small JSON state file with `Crit`, `Warn`, `Info` counts and the list of CRIT/WARN findings. No console output unless `-Json` is also passed.
- **Alert banner** in the brief header: if the auto-audit found any CRIT or WARN findings, a slim banner appears above the menu with severity, counts, and a hint to type `a` for details. If clean, a green `audit ✓` badge appears inline in the header alongside `gentle-ai`.
- The audit state file is also re-generated whenever the user runs the audit interactively from the prompt — so the banner stays current.

### Compact render
- Removed double blank lines between sections (was wasting vertical space on smaller terminals).
- Header rule no longer followed by a blank line; the eye picks up the section change from the bold heading.
- Tighter spacing inside "Ayer hiciste" — projects now flow continuously instead of being separated by a blank line.
- Footer remains on one line, now with `l log` added (was missing).
- Net effect: the same content fits in ~6 fewer lines, which matters on adaptive 28-line laptop screens.

### Logged
Each auto-audit run logs `Auto-audit ran in Nms` at INFO level so you can see latency in `~/.claude/logs/startup-kit.log`.

## 2.2.0 — 2026-05-01

### TUI multi-screen (already there + new screen)
The brief is effectively a multi-screen TUI now. From the prompt you can navigate between:
- **Brief** (default) — projects menu + recent activity
- **Audit** (`a`) — security/integrity audit (added in 2.1.0)
- **Logs** (`l`) — **NEW**: tail the last 50 lines of `~/.claude/logs/startup-kit.log` with ERROR/WARN/INFO color coding. Press ENTER to return.
- **Help** (`?`) — full keybinding reference
- **Config** (`c`) — opens `startup-kit-config.json` in VS Code

Each screen returns cleanly to the brief on ENTER.

### `l` command implementation
- Reads `~/.claude/logs/startup-kit.log` with `Get-Content -Tail 50`.
- Colorizes `[ERROR]` lines red, `[WARN]` yellow, `[INFO]` gray.
- Press ENTER to return to the menu.
- If no log file exists yet, shows a friendly message instead.

### Footer + help screen updated to surface the new command
Footer now reads:
`número para abrir · p# fijar · t tema · a audit · l log · c config · ? ayuda · q salir`

### Decision: stayed PowerShell-only for the multi-screen
A full TUI framework rewrite (e.g. Spectre.Console, terminal.gui) was considered and skipped — it would force a major architectural change for limited gain. The current screen pattern (each command Clears-Host, renders its view, Read-Host, returns) is simple, fast, and free of dependencies. If a richer TUI is ever needed, that's the cross-platform Go/Rust rewrite from `ROADMAP.md`.

## 2.1.0 — 2026-05-01

### New: `claude-audit.ps1` — security/integrity audit
A standalone command that walks `~/.claude` looking for drift from a known-good baseline. **NOT an antivirus** — it can't detect unknown malware. What it CAN do is flag risky settings and unfamiliar files quickly.

**8 categories of checks** (with severity levels OK / INFO / WARN / CRIT):

| Category | What it inspects |
|----------|------------------|
| **PROCESSES** | Long-running Claude/VS Code/PowerShell/cmd processes (>12h INFO, >48h WARN) |
| **HOOKS** | All `SessionStart` hooks; flags any not from the kit |
| **PERMISSIONS** | Allow-rules in `settings.json` against risky patterns: `rm -rf`, `sudo`, `curl ... \| bash`, `iex`, `Invoke-Expression`, `..\..` (path traversal). Hits = CRIT. |
| **SCRIPTS** | Files in `~/.claude/scripts/` and `lib/` not on the kit whitelist |
| **PLUGINS** | `enabledPlugins` and registered marketplaces with their source repos |
| **LOGS** | Recent ERROR / WARN counts in `startup-kit.log` (last 200 lines) |
| **DISK** | `~/.claude` total + breakdown (projects/, logs/, backups/). >5 GB = WARN. |
| **NETWORK** | Established TCP connections from Claude processes to non-localhost endpoints (use `-NoNetwork` to skip) |
| **KIT** | Reports installed kit version |

**Modes**:
- `claude-audit.ps1` — colored table (default)
- `claude-audit.ps1 -Json` — pipe-friendly JSON output
- `claude-audit.ps1 -NoNetwork` — skip TCP connection scan

### `a` command in the brief
From the prompt, type `a` to invoke the audit inline. Press ENTER to return to the menu.

### Install updates
- `install.ps1` now copies `claude-audit.ps1` and BOMs it.
- `health-check.ps1` whitelist updated to include `claude-audit.ps1`, plus the previously-missing entries for `health-check.ps1`, `standup.ps1`, `lib/screen-adapt.ps1`, `lib/render-layout.ps1`.

### Tested in this release
Ran on the dev machine: 0 CRIT, 0 WARN, 12 INFO. Detected 2 non-kit files (`toast-daily-brief.ps1`, `demo-messagebox.ps1`) from earlier POC sessions — exactly the kind of drift the tool is meant to surface.

## 2.0.0 — 2026-04-28

### Why a major bump
Two milestones land together: an automated test suite for the library modules,
and a public roadmap for the work that wouldn't fit a single release.

### Pester test suite
- New `tests/` directory with Pester v5 specs covering the library modules:
  - `tests/config.Tests.ps1` — `Get-StartupKitConfig` defaults, user merge,
    underscore-key skipping, unknown-key tolerance, invalid-JSON fallback.
  - `tests/screen-adapt.Tests.ps1` — `Get-AdaptiveDimensions` bounds, custom
    min/max parameters, reported screen dimensions.
  - `tests/themes.Tests.ps1` — `Get-StartupKitTheme` default, requested theme,
    case-insensitive match, fallback to default for unknown names, every
    shipped theme exposes the full color key set.
  - `tests/render-layout.Tests.ps1` — `Get-VisibleLength` strips ANSI,
    `Format-PadRight` pads correctly while ignoring ANSI, no mid-ANSI truncation.
- CI workflow extended: installs Pester v5 fresh, runs the suite with NUnit
  XML output, uploads results as a GitHub Actions artifact, and fails the
  build if any test fails.

### Roadmap
- New `ROADMAP.md` documents the two big projects that are *not* in scope for
  the 1.x line: cross-platform Mac/Linux rewrite (Go or Rust, sub-100ms cold
  start), and Choco/Scoop/Brew distribution (depends on the binary). Each
  with tradeoffs, acceptance criteria, and effort estimates so the path is
  clear when someone picks them up.
- Pomodoro and AI-suggested-project are listed as **deliberately excluded**
  to prevent re-proposal in future planning.

## 1.4.0 — 2026-04-28

### New commands at the prompt
- **`t`** — cycle through themes live (`default → dracula → solarized → nord → monochrome → default`). Persists to `startup-kit-config.json` automatically. Re-renders with the new colors immediately.
- **`c`** — opens `startup-kit-config.json` in VS Code via `code.cmd`. No more navigating to the path manually.
- **`?`** — full help screen listing every command with a one-line description. Press ENTER to return to the menu. Decongests the footer (which now only shows the most-used commands).

### Engram improvements
- **Smarter project-name matching**: `Resolve-EngramProjectName` reads `engram projects list` once, caches the names, and tries (1) exact match → (2) prefix match → (3) substring match before falling back to the folder leaf. This fixes the case where a user's project is registered in Engram under a slightly different name (e.g. `polymarket-bot` in Engram vs `PolyMarket` on disk).
- **Git fallback in "Ayer hiciste"**: when Engram has no `session_summary` for a project but the project is a git repo with a recent commit, the brief now promotes the commit subject as the headline instead of showing `(sin summary en Engram)`. Result: every recent project shows something useful.

### Footer redesign
- Footer is now a single concise line: `número para abrir · p# fijar · t tema · c config · ? ayuda · q salir [· u actualizar]`.
- The keybinding-soup that was there before lives in the `?` help screen now.

## 1.3.3 — 2026-04-28

### Bug fixes
- **`p#` pin/unpin now actually works**. The footer documented `p# fijar` since v1.1.0, but the prompt loop's regex never accepted `p<num>` — the handler was missing entirely. Now you can pin/unpin a project from the menu by typing `p2` (toggles project #2's pin status, persists to `startup-kit-config.json`, re-renders the menu so the new order is visible).
- **`Set-PinnedToggle`** function added: reads user config, toggles project in/out of `pinned[]`, writes back, and updates the in-memory `$script:pinnedNames` so the next render reflects the change without reloading.
- **Pin event logged**: `Pin toggle: 'PolyMarket' -> pinned (now 2 pinned)` (and same on unpin).
- **`health-check.ps1` no longer warns about non-kit files**. Previously it scanned every `.ps1` in `~/.claude/scripts/` for BOMs, which flagged unrelated user scripts (POCs, demos). Now it uses an explicit whitelist of files the kit installs and ignores everything else.
- **Removed dead helpers from `lib/render-layout.ps1`**: `New-Card`, `New-StatTile`, `New-NodeCode`, `New-SessionId`, `Format-SideBySide`. Tras el rediseño v1.3.0, none of these were called anymore; only `Get-VisibleLength` and `Format-PadRight` remain. Net: -150 lines of unused code.
- Removed unused `$libDir` variable in `health-check.ps1` (linter warning).

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
