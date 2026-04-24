# Changelog

## 1.0.0 — 2026-04-24

Initial release.

### Features
- **Daily gentle-ai auto-update**: SessionStart hook checks GitHub once per 24h and applies updates via the official PowerShell installer.
- **Daily Brief inside Claude Code**: SessionStart hook injects a structured `[daily-brief:trigger]` block on the first session of each calendar day. CLAUDE.md user-custom rule tells the model how to render it.
- **Startup launcher on PC boot**: TOPMOST cmd window with project menu. Picking a project opens it minimized in VS Code; brief stays visible for more picks.
- **Config-driven**: `~/.claude/scripts/startup-kit-config.json` overrides defaults (window size, font, activity window, etc).
- **Modular**: real logic in `scripts/lib/` — config, logging, scan-projects (native PS, no Python subprocess), engram.
- **Real Engram summaries**: AYER EN RESUMEN pulls the latest `session_summary` Goal per project from the Engram CLI.
- **File-based logs**: every script writes to `~/.claude/logs/startup-kit.log` for debugging silent failures.
- **Idempotent installer**: `install.ps1` detects existing entries by command/marker, supports `-DryRun`, backs up `settings.json` and `CLAUDE.md` before changes, and validates JSON post-install.
- **Clean uninstall**: `uninstall.ps1` strips hooks, blocks, scripts, and the Startup launcher.
- **CI**: GitHub Actions validates `.ps1` / `.sh` / `.bat` syntax on every push.
