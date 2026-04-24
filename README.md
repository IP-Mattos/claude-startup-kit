# Claude Startup Kit

Personal toolkit that adds three quality-of-life pieces around [Claude Code](https://claude.com/claude-code) on Windows:

1. **Daily gentle-ai auto-update** — checks the latest [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) release once per 24h on every Claude Code SessionStart and applies the update silently.
2. **Daily Brief inside Claude Code** — on the first session of each calendar day, injects a `[daily-brief:trigger]` system-reminder with your active projects so the model can present a structured welcome (resume of yesterday's work + a numbered project menu that opens any project as a workspace).
3. **Startup launcher on PC boot** — a small, always-on-top cmd window opens at Windows login showing the same brief plus an interactive picker. Tap a number → VS Code opens that project in a new minimized window. Stays visible (TOPMOST) and out of the way.

## Requirements

- Windows 10/11
- [Claude Code](https://claude.com/claude-code) installed (`~/.claude/` exists)
- Engram MCP plugin enabled in Claude Code
- [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) installed and on PATH
- Python 3 on PATH
- VS Code with the `code` CLI on PATH

## Install

```powershell
git clone git@github.com:IP-Mattos/claude-startup-kit.git
cd claude-startup-kit
.\install.ps1
```

The installer is **idempotent** — safe to run multiple times. It detects existing entries by command/marker and only adds what's missing.

## What it touches

| Path | Action |
|------|--------|
| `~/.claude/scripts/check-gentle-ai.sh` | Copied (hook target) |
| `~/.claude/scripts/daily-brief.sh` | Copied (hook target) |
| `~/.claude/scripts/startup-brief.ps1` | Copied with UTF-8 BOM |
| `~/.claude/scripts/startup-brief-launcher.bat` | Copied |
| `~/.claude/settings.json` | Merges 2 entries into `hooks.SessionStart` (skip if present) |
| `~/.claude/CLAUDE.md` | Appends 2 `<!-- user-custom:... -->` blocks (skip if present) |
| `~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/claude-daily-brief.bat` | Installed |

State files (regenerated automatically; not copied or pushed):
- `.gentle-ai-last-check`, `.daily-brief-last-date`, `.gentle-ai-last-seen-version`

## Uninstall

```powershell
.\uninstall.ps1
```

Removes everything install.ps1 added. Cleanly strips hooks from `settings.json` and the user-custom blocks from `CLAUDE.md`.

## Why the `<!-- user-custom:... -->` pattern in CLAUDE.md

The global `~/.claude/CLAUDE.md` is fully managed by gentle-ai's `<!-- gentle-ai:... -->` blocks. Anything inserted inside one of those blocks gets overwritten on `gentle-ai sync`. The user-custom blocks live OUTSIDE all gentle-ai blocks, so they survive sync. The installer detects them by their marker and never duplicates them.

## Non-obvious gotchas baked into the scripts

- **PowerShell needs a UTF-8 BOM** in `.ps1` files for box drawing / Unicode characters to render correctly. Installer adds the BOM after copying.
- **`[System.Text.Encoding]::UTF8` adds a BOM on .NET Framework / Windows PowerShell 5.1**, which leaks to piped subprocesses. The startup-brief uses `[System.Text.UTF8Encoding]::new($false)` (no BOM) for stdin/stdout encoding.
- **`code` CLI ambiguity**: on Windows, `where code` returns `Code.exe`, `code` (MSYS shell wrapper), and `code.cmd`. The wrapper that handles `--folder-uri` is `code.cmd`; the script invokes it explicitly.
- **NTFS doesn't update folder mtime on file modification** (only on create/delete). The brief looks at the newest JSONL inside a project folder, not the folder mtime, so an active session marks the project as "today".
- **VS Code opens an "untitled" buffer** for paths that don't exist (e.g. when a project folder is moved). The brief filters projects whose `cwd` no longer exists on disk.
- **Windows anti-focus-stealing**: `SetForegroundWindow` is silently ignored when called from a non-foreground process. The brief works around this by being TOPMOST instead.

## License

Personal toolkit; reuse at your own risk.
