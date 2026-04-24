# Claude Startup Kit

[![CI](https://github.com/IP-Mattos/claude-startup-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/IP-Mattos/claude-startup-kit/actions/workflows/ci.yml)

Personal toolkit that adds three quality-of-life pieces around [Claude Code](https://claude.com/claude-code) on Windows:

1. **Daily gentle-ai auto-update** — checks the latest [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) release once per 24h on every Claude Code SessionStart and applies the update silently.
2. **Daily Brief inside Claude Code** — on the first session of each calendar day, injects a `[daily-brief:trigger]` system-reminder with your active projects so the model can present a structured welcome (resume of yesterday's work + a numbered project menu that opens any project as a workspace).
3. **Startup launcher on PC boot** — a small, always-on-top cmd window opens at Windows login showing the same brief plus an interactive picker. Tap a number → VS Code opens that project in a new minimized window. Stays visible (TOPMOST) and out of the way.

## Requirements

- Windows 10/11
- [Claude Code](https://claude.com/claude-code) installed (`~/.claude/` exists)
- Engram MCP plugin enabled in Claude Code (optional but recommended — without it, the AYER EN RESUMEN section falls back to a placeholder)
- [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) installed and on PATH
- VS Code with the `code` CLI on PATH

> No Python required. Project scanning is done in native PowerShell.

## Install

```powershell
git clone https://github.com/IP-Mattos/claude-startup-kit.git
cd claude-startup-kit
.\install.ps1
```

The installer is **idempotent** — safe to run multiple times. Detects existing entries by command/marker and only adds what's missing.

### Flags

| Flag | What it does |
|------|--------------|
| `-DryRun` | Show what would change without touching anything |
| `-Force` | Overwrite the user config (`startup-kit-config.json`) with the shipped defaults |

## Configuration

The first install copies `claude-templates/default-config.json` to `~/.claude/scripts/startup-kit-config.json`. Edit that file to customize:

```json
{
  "window": {
    "cols": 120,
    "lines": 32,
    "fontSize": 14,
    "fontName": "Consolas",
    "topmost": true,
    "startMinimized": true
  },
  "projects": {
    "activityWindowDays": 14,
    "recentForBriefDays": 2
  },
  "vsCode": {
    "minimizeAfterLaunch": true,
    "openInNewWindow": true
  },
  "engram": {
    "fetchSummariesForBrief": true,
    "summaryMaxChars": 90
  }
}
```

Subsequent installs **preserve your config** unless you pass `-Force`.

## Logs

All scripts write to `~/.claude/logs/startup-kit.log`:

```
[2026-04-24 18:32:01] [INFO] [check-gentle-ai] Hook fired
[2026-04-24 18:32:01] [INFO] [daily-brief] Hook fired
[2026-04-24 18:32:01] [INFO] [daily-brief] Skipped (already ran today: 20260424)
[2026-04-24 18:35:14] [INFO] [startup-brief] Brief launched
[2026-04-24 18:35:14] [INFO] [startup-brief] Scanned 8 projects in 142ms
[2026-04-24 18:35:14] [INFO] [startup-brief] Engram summaries: 4/4 projects in 380ms
[2026-04-24 18:35:22] [INFO] [startup-brief] Opening project 'PolyMarket' at c:\Users\...\PolyMarket
[2026-04-24 18:35:24] [INFO] [startup-brief] Minimized VS Code window for 'PolyMarket'
```

## Repo layout

```
claude-startup-kit/
├── install.ps1                  ← idempotent installer (-DryRun, -Force)
├── uninstall.ps1                ← clean removal
├── VERSION                      ← semver, read by installer
├── CHANGELOG.md
├── scripts/
│   ├── check-gentle-ai.sh       ← daily auto-update
│   ├── daily-brief.sh           ← first-of-day trigger inside Claude
│   ├── startup-brief.ps1        ← orchestrator (small, calls lib/)
│   ├── startup-brief-launcher.bat
│   └── lib/
│       ├── config.ps1           ← config loader (defaults + user merge)
│       ├── logging.ps1          ← file-based logger
│       ├── scan-projects.ps1    ← native PS scanner (replaces Python)
│       └── engram.ps1           ← engram CLI wrapper for AYER EN RESUMEN
├── claude-templates/
│   ├── default-config.json      ← shipped defaults
│   ├── claude-md-snippets.md    ← user-custom blocks for CLAUDE.md
│   └── settings-hooks.json      ← reference hook structure
└── .github/workflows/ci.yml     ← validates .ps1 / .sh / .bat / .json on push
```

## What it touches on install

| Path | Action |
|------|--------|
| `~/.claude/scripts/*.sh`, `*.ps1`, `*.bat` | Copied (kit-managed) |
| `~/.claude/scripts/lib/*.ps1` | Copied (kit-managed) |
| `~/.claude/scripts/startup-kit-config.json` | Copied only if missing (or `-Force`) |
| `~/.claude/scripts/.kit-version` | Tracks installed version |
| `~/.claude/settings.json` | Merges 2 entries into `hooks.SessionStart` (skip if present, JSON validated post-write) |
| `~/.claude/CLAUDE.md` | Appends 2 `<!-- user-custom:... -->` blocks (skip if present) |
| `~/.claude/logs/` | Created |
| `~/.claude/backups/startup-kit-<timestamp>/` | Backup of `settings.json` + `CLAUDE.md` before changes |
| `~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/claude-daily-brief.bat` | Installed |

State files (regenerated automatically; `.gitignored`):
- `.gentle-ai-last-check`, `.daily-brief-last-date`, `.gentle-ai-last-seen-version`

## Uninstall

```powershell
.\uninstall.ps1
```

Reverses everything install.ps1 did — strips hooks from `settings.json`, removes user-custom blocks from `CLAUDE.md`, removes scripts and the Startup launcher.

## Sync workflow (multiple machines)

Edit on PC A:
```powershell
git add . ; git commit -m "..." ; git push
```

On PC B:
```powershell
git pull ; .\install.ps1
```

Idempotent — only adds what's missing. Bumping the `VERSION` file causes the installer to log the upgrade.

## Why the `<!-- user-custom:... -->` pattern in CLAUDE.md

The global `~/.claude/CLAUDE.md` is fully managed by gentle-ai's `<!-- gentle-ai:... -->` blocks. Anything inserted inside one of those blocks gets overwritten on `gentle-ai sync`. The user-custom blocks live OUTSIDE all gentle-ai blocks, so they survive sync. The installer detects them by their marker and never duplicates them.

## Non-obvious gotchas baked into the scripts

- **PowerShell needs a UTF-8 BOM** in `.ps1` files for box drawing / Unicode characters to render correctly. Installer adds the BOM after copying.
- **`[System.Text.Encoding]::UTF8` adds a BOM on .NET Framework / Windows PowerShell 5.1**, which leaks to piped subprocesses. The startup-brief uses `[System.Text.UTF8Encoding]::new($false)` (no BOM) for stdin/stdout encoding.
- **`code` CLI ambiguity**: on Windows, `where code` returns `Code.exe`, `code` (MSYS shell wrapper), and `code.cmd`. The wrapper that handles `--folder-uri` is `code.cmd`; the script invokes it explicitly.
- **NTFS doesn't update folder mtime on file modification** (only on create/delete). The brief looks at the newest JSONL inside a project folder, not the folder mtime, so an active session marks the project as "today".
- **VS Code opens an "untitled" buffer** for paths that don't exist (e.g. when a project folder is moved). The brief filters projects whose `cwd` no longer exists on disk.
- **Windows anti-focus-stealing**: `SetForegroundWindow` is silently ignored when called from a non-foreground process. The brief works around this by being TOPMOST instead.
- **`start /MIN` doesn't propagate** to GUI apps that self-activate (like VS Code). The brief launches code.cmd normally, then `FindWindow` by expected title (`<folder> - Visual Studio Code`) and `ShowWindow(SW_MINIMIZE)` post-launch.

## License

Personal toolkit; reuse at your own risk.
