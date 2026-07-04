# Claude Startup Kit

A Windows desktop companion for [Claude Code](https://claude.ai/code) — overview of your active projects, conversation search, a team task board, audit findings, cleanup, a Gentle-AI stack view, and a bundled terminal dashboard (claudewatch).

> **Status:** active development on the `desktopapp` branch. The app supersedes an older PowerShell installer + scripts kit, which now lives under [`legacy/`](legacy/) for reference.

---

## Stack

- **Tauri 2** — Rust backend, native window, tray-icon-only lifecycle, signed self-updater.
- **React 19 + TypeScript + Vite** — frontend at [`src/`](src/).
- **Rust** — IPC commands at [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) plus the Trello module at [`src-tauri/src/trello/`](src-tauri/src/trello/).
- **Go** — the claudewatch TUI at [`tools/claudewatch/`](tools/claudewatch/), built in CI and bundled as a Tauri resource.

The app shells out to system tools when present (`git`, `engram`, `gh`, `gentle-ai`, `claude`, `powershell`) and degrades gracefully when they aren't.

---

## Quick start

```powershell
# 1. install deps
pnpm install

# 2. dev — full desktop app with MSVC bootstrap
./dev.ps1
```

`./dev.ps1` resolves `vcvars64`, kills any prior dev instance, then runs `pnpm tauri dev`. The window opens at ~1100×760 with the V3 layout.

For frontend-only browser preview (no Tauri APIs):

```powershell
pnpm dev   # http://localhost:1420
```

Type-check without building:

```powershell
pnpm typecheck
```

---

## Layout

```
.
├── src/                # React 19 frontend
│   ├── v3/             # shell — AppV3.tsx, AppV3.css, themes/, v3types.ts
│   ├── views/v3/       # one file per tab (ProjectsView, TrelloView, ClaudeView, …)
│   ├── components/v3/  # shared components (Topbar, Sidebar, CommandPalette, trello/, …)
│   ├── lib/            # hooks + helpers (themes, i18n, useUpdates, trello/, audit)
│   └── constants/      # navigation catalogs (v3Nav.ts)
├── src-tauri/          # Rust + Tauri config
│   ├── src/lib.rs           # all #[tauri::command] entry points
│   ├── src/trello/          # Trello-equipo API client, subscriber, storage
│   ├── capabilities/        # permission allowlist
│   ├── resources/claudewatch/  # bundled TUI (exe built in CI, gitignored)
│   ├── tauri.conf.json
│   └── Cargo.toml
├── tools/claudewatch/  # Go TUI source (own go.mod)
├── public/             # static assets (icons, companions)
├── legacy/             # archived PowerShell kit — install.ps1, scripts, tests
├── dev.ps1             # MSVC-bootstrapping launcher for tauri dev
├── CLAUDE.md           # architectural notes for AI assistants
└── AUDIT.md            # known-issue backlog (pass-4 audit)
```

---

## Tabs (V3 layout)

Navigation is two-track: the sidebar carries the six operational tabs, the topbar carries the meta tabs (Claude, Settings).

| Tab | What it does |
|-----|--------------|
| Overview | Greeting, today's project, summary stats, recent projects, audit summary |
| Projects | Lists projects under `~/.claude/projects/` with last-activity, goal (from engram), git status; open in VS Code or in the claudewatch TUI |
| Conversations | Full-text search across your Claude Code conversation JSONLs, filterable by project |
| Trello | Team task board (Trello-equipo API): live board via a Rust-side polling subscriber, task create/edit, JSON import/export |
| Audit | Findings from `claude-audit.ps1` grouped by severity, with severity + category filters |
| Cleanup | Old logs / backups / project caches under `~/.claude/` — preview + confirm before delete |
| Claude *(topbar)* | Gentle-AI stack view — sub-tabs for overview, components, skills, MCP servers, and skill discovery |
| Settings *(topbar)* | Theme picker (8 themes), language (EN/ES), updates (app / Claude Code / gentle-ai / stack tools), claudewatch install, companion config |

### Keyboard shortcuts
`Ctrl+1..6` switch sidebar tabs · `Ctrl+R` refresh · `Ctrl+K` command palette · `Ctrl+,` settings · `Ctrl+T` cycle theme

---

## Themes

8 themes under [`src/v3/themes/`](src/v3/themes/), lazy-loaded on demand via `import.meta.glob` — each theme is its own code-split chunk. The active theme is set on `<body data-theme-v3="...">` (light = no attribute) and persisted in `localStorage["csk-theme-v3"]`.

Adding a new theme:

1. Drop `name.css` in `src/v3/themes/` — scope all rules under `body[data-theme-v3="name"] .appv3 ...`.
2. Register it in [`src/lib/themes.ts`](src/lib/themes.ts): add the id to `V3_THEME_ORDER` and an entry (label + swatch) to `V3_THEME_OPTIONS`.

The glob import and the Vite `manualChunks` rule pick the file up automatically. The token contract (`--v3-bg`, `--v3-surface`, `--v3-text`, `--v3-accent`, semantic colors, shadows) lives at the top of `AppV3.css`.

---

## Updates

Four channels, all surfaced in Settings (the first two also as banners, on a 24h per-channel cooldown stored in `localStorage`):

| Channel | Source | Apply action |
|---------|--------|--------------|
| **App (Claude Startup Kit)** | `latest.json` on this repo's GitHub releases | Signed Tauri self-updater — downloads, verifies the minisign signature, installs, restarts |
| **gentle-ai** | `Gentleman-Programming/gentle-ai` GitHub releases | Runs the upstream PowerShell installer and reports the new version |
| **Claude Code** | `claude --version` vs upstream | One-click update from Settings → Claude Code |
| **Stack tools** | Per-tool version probes | Dynamic "Stack tools" card in Settings → Updates |

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml): pushing a `v*` tag builds the Windows bundle (including the claudewatch exe), signs the installers with the updater key, and publishes `latest.json` alongside them.

---

## claudewatch (TUI)

A Go terminal dashboard bundled with the app. Settings → claudewatch installs (or re-syncs) it to `~/claudewatch/`; each project row offers "Open in TUI", which auto-syncs the binary and launcher scripts from the app bundle before launching so they never skew.

---

## Security model

The Tauri side guards every IPC that touches the filesystem with:

- `validate_open_path()` — refuses empty / flag-prefixed (`-x`) / shell-protocol / UNC / non-existent paths, then canonicalizes and strips the `\\?\` prefix.
- Path canonicalization + allow-listed roots check (`cleanup_apply` against `~/.claude/{logs,backups,projects}`).
- Symlink rejection via `symlink_metadata`.
- All subprocesses spawned through `silent_command()` (`CREATE_NO_WINDOW`); URLs opened via `rundll32 url.dll,FileProtocolHandler`, never `cmd /c`.
- Strict CSP in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).
- Trello API client enforces HTTPS for the bearer-token endpoint.

The open backlog (Trello token storage, capability scoping, a11y gaps, perf items) is documented in [`AUDIT.md`](AUDIT.md).

---

## Branches

- **`desktopapp`** — active branch for the Tauri app.
- **`main`** — legacy shell-kit history, kept for reference.

---

## Legacy kit

The original `claude-startup-kit` was a pure PowerShell project: an idempotent installer that wrote SessionStart hooks into `~/.claude/settings.json`, dropped a startup brief and audit script under `~/.claude/scripts/`, and registered a Startup launcher.

Sources are preserved at `legacy/` (`install.ps1`, `uninstall.ps1`, `scripts/`, `tests/`, `claude-templates/`, `VERSION`, `CHANGELOG.md`, `ROADMAP.md`). The Tauri app reads `~/.claude/projects/` directly and shells out to the legacy `claude-audit.ps1` only as an interop point — the long-term plan is to port that logic to Rust.

---

## License

See [`legacy/`](legacy/) for the original project's notes; the desktop app inherits the same terms unless explicitly noted.
