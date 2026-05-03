# Claude Startup Kit

A Windows desktop companion for [Claude Code](https://claude.ai/code) — overview of your active projects, GitHub PR review queue, audit findings, cleanup, and a configurable companion in the right panel.

> **Status:** active development on the `desktopapp` branch. The app supersedes an older PowerShell installer + scripts kit, which now lives under [`legacy/`](legacy/) for reference.

---

## Stack

- **Tauri 2** — Rust backend, native window, tray-icon-only lifecycle.
- **React 19 + TypeScript + Vite** — frontend at [`src/`](src/).
- **Rust** — IPC commands at [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).

The app shells out to system tools when present (`gh`, `engram`, `git`, `code.cmd`) and degrades gracefully when they aren't.

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
├── src/            # React 19 frontend
│   ├── v3/         # active layout — AppV3.tsx, views.tsx, themes/
│   ├── lib/        # format helpers, enrichProjects
│   ├── App.tsx     # legacy V1 layout (lazy-loaded via console backdoor)
│   └── components/
├── src-tauri/      # Rust + Tauri config
│   ├── src/lib.rs           # all #[tauri::command] entry points
│   ├── capabilities/        # permission allowlist
│   ├── tauri.conf.json
│   └── Cargo.toml
├── public/         # static assets (icons, mascots)
├── legacy/         # archived PowerShell kit — install.ps1, scripts, tests
├── dev.ps1         # MSVC-bootstrapping launcher for tauri dev
├── package.json
├── vite.config.ts
├── tsconfig.json
├── CLAUDE.md       # architectural notes for AI assistants
└── AUDIT.md        # known-issue backlog from pass-3 audit
```

---

## Tabs (V3 layout)

| Tab | What it does |
|-----|--------------|
| Overview | Greeting, today's project, summary cards, recent projects + PRs, audit summary |
| Projects | Lists projects under `~/.claude/projects/` with last-activity, goal (from engram), git status |
| PRs | GitHub review queue via `gh search prs --review-requested` |
| Audit | Findings from `claude-audit.ps1` grouped by severity |
| Cleanup | Old logs / backups / project caches under `~/.claude/` — preview + confirm before delete |
| Companions | Configure the right-panel companion's name + image |
| Settings | Theme picker (28 themes), keyboard shortcuts cheat-sheet |

### Keyboard shortcuts
`Ctrl+1..7` switch tabs · `Ctrl+R` refresh · `Ctrl+,` settings · `Ctrl+T` cycle theme

---

## Themes

28 themes under [`src/v3/themes/`](src/v3/themes/). The active theme is set on `<body data-theme-v3="...">` and persisted in `localStorage["csk-theme-v3"]`.

Adding a new theme:

1. Drop `name.css` in `src/v3/themes/` — scope all rules under `body[data-theme-v3="name"] .appv3 ...`.
2. `@import` it from [`src/v3/AppV3.css`](src/v3/AppV3.css).
3. Extend `V3_THEME_ORDER` in [`src/v3/AppV3.tsx`](src/v3/AppV3.tsx) and `V3_THEMES` in [`src/v3/views.tsx`](src/v3/views.tsx).

The token contract (`--v3-bg`, `--v3-surface`, `--v3-text`, `--v3-accent`, semantic colors, shadows) lives at the top of `AppV3.css`.

---

## Updates

The app checks two channels every 24h (cooldown is per-channel, stored in
`localStorage`):

| Channel | Source | Apply action |
|---------|--------|--------------|
| **Claude Startup Kit** | `IP-Mattos/claude-startup-kit` GitHub releases | Opens the release page in the default browser. |
| **gentle-ai** | `Gentleman-Programming/gentle-ai` GitHub releases | Runs the upstream PowerShell installer (`irm <installer> \| iex`) and reports the new version. |

If an update is available, a banner appears above the content with `Update
now` / `Open release` and `Later` actions. Dismissed versions are remembered
per-channel so the same banner doesn't follow you forever. Settings → Updates
shows the live status and a `Check now` button that bypasses the cooldown.

The "configured" state in Settings reads:

- **App**: `Not configured` until a release is published on the GitHub repo.
- **gentle-ai**: `Not configured` if `gentle-ai` is not on `PATH`.

This intentionally keeps the IPC contract stable so a future migration to
`tauri-plugin-updater` (signed bundles, atomic install, auto-restart) can
swap the implementation without touching the frontend. Signing keys + a
release pipeline are the prerequisites for that upgrade.

## Security model

The Tauri side guards every IPC that touches the filesystem with:

- `validate_open_path()` — refuses empty / flag-prefixed (`-x`) / shell-protocol / UNC / non-existent paths.
- Path canonicalization + allow-listed roots check (`cleanup_apply` against `~/.claude/{logs,backups,projects}`).
- Symlink rejection via `symlink_metadata`.
- `--` end-of-options separator on `code.cmd` and `explorer` invocations.
- Strict CSP in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).

Open backlog of higher-severity items (PATH shadowing, unbounded `gh` limit, CSP directives) is documented in [`AUDIT.md`](AUDIT.md).

---

## Branches

- **`desktopapp`** — active branch for the Tauri app.
- **`main`** — legacy shell-kit history, kept for reference.
- **`feat/tauri-rewrite`** — pre-restructure development branch (snapshot before the `app/` → root promotion).

---

## Legacy kit

The original `claude-startup-kit` was a pure PowerShell project: an idempotent installer that wrote SessionStart hooks into `~/.claude/settings.json`, dropped a startup brief and audit script under `~/.claude/scripts/`, and registered a Startup launcher.

Sources are preserved at `legacy/` (`install.ps1`, `uninstall.ps1`, `scripts/`, `tests/`, `claude-templates/`, `VERSION`, `CHANGELOG.md`, `ROADMAP.md`). The Tauri app reads `~/.claude/projects/` directly and shells out to the legacy `claude-audit.ps1` only as an interop point — the long-term plan is to port that logic to Rust.

---

## License

See [`legacy/`](legacy/) for the original project's notes; the desktop app inherits the same terms unless explicitly noted.
