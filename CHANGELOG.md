# Changelog

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
