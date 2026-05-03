# Roadmap — Claude Startup Kit (desktopapp branch)

Living doc for cross-PC continuity. Reflects state at last commit on
`desktopapp`; update as work progresses.

---

## Current state — what ships today

The Tauri desktop app is fully usable. The PowerShell kit is archived
under `legacy/`.

### Layout

```
.
├── src/                          # React 19 frontend
│   ├── v3/                       # active layout (AppV3 root + CSS + types + themes/)
│   │   ├── AppV3.tsx             # thin orchestrator (~330 lines)
│   │   ├── AppV3.css             # base tokens + component styles
│   │   ├── v3types.ts            # V3Tab, WorkspaceSummary
│   │   └── themes/               # 8 theme files (light, dark, retro-os,
│   │                               chrome95, lunar-hud, lilac-stickers,
│   │                               y2k-pop, pixel-crt)
│   ├── components/v3/            # presentational components
│   │   ├── Topbar.tsx
│   │   ├── Sidebar.tsx
│   │   ├── StatusBar.tsx
│   │   ├── CompanionWidget.tsx
│   │   ├── WorkspaceCard.tsx
│   │   └── OverviewView.tsx (with StatCard, RecentProjectCard, PrRow)
│   ├── views/v3/                 # one file per tab/view
│   │   ├── ProjectsView.tsx
│   │   ├── PrsView.tsx
│   │   ├── AuditView.tsx (with FilterChip, FindingRow)
│   │   ├── CleanupView.tsx
│   │   ├── ClaudeView.tsx
│   │   ├── CompanionsView.tsx
│   │   ├── SettingsView.tsx (with UpdateRow)
│   │   └── SyncView.tsx (with SyncCard)
│   ├── hooks/
│   │   └── useDebouncedValue.ts
│   ├── lib/
│   │   ├── i18n.ts               # 200+ keys, en + es (Rioplatense)
│   │   ├── format.ts             # agoLabel, pickGreeting, projectName,
│   │   │                           prNumberFromUrl, friendlyError(En),
│   │   │                           activityLabel(En|T), onKeyboardActivate
│   │   ├── themes.ts             # V3_THEME_ORDER, loader, helpers
│   │   ├── audit.ts              # parseAuditFindings (boundary validator)
│   │   ├── enrichProjects.ts     # batch project enrichment
│   │   └── useUpdates.ts         # update channel hook
│   ├── constants/
│   │   └── v3Nav.ts              # SIDEBAR_NAV, TOPBAR_NAV, KEYBOARD_TAB_ORDER
│   └── main.tsx                  # entry, theme boot
├── src-tauri/                    # Rust backend
│   ├── src/lib.rs                # all #[tauri::command] entry points
│   ├── capabilities/default.json # permission allowlist
│   ├── tauri.conf.json
│   └── Cargo.toml
├── public/                       # static assets (Shield.svg, mascots)
├── legacy/                       # archived PowerShell kit
├── dev.ps1                       # MSVC-bootstrapping launcher
├── package.json
├── vite.config.ts
├── tsconfig.json
├── AUDIT.md                      # pass-3 backlog (lower-priority items)
└── ROADMAP.md                    # this file
```

### Tabs (V3 layout)

Sidebar (high-frequency, Ctrl+1..5):

- Overview — greeting, stat row, recent projects, recent PRs, audit summary
- Projects — list under `~/.claude/projects/`, search, time window, open in VS Code / Explorer
- PRs — `gh search prs --review-requested`, search by title/repo/author
- Audit — `claude-audit.ps1` findings grouped by severity
- Cleanup — preview + confirm delete under `~/.claude/{logs,backups,projects}`

Topbar (low-frequency):

- Sync — engram sync over private GitHub repo + project-clone catalog
- Claude — MCP servers (toggle on/off) + Skills (sorted by recent usage)
- Companion — name + avatar configuration
- Settings — language picker, updates, themes, keyboard shortcuts

Right panel:

- CompanionWidget (mascot, contextual nudge, primary CTA)
- WorkspaceCard (skills used / engram observations / app + gentle-ai versions)

### Themes

8 themes ship today (each with real component personality, not just a
recolor):

- `light`, `dark` — defaults
- `retro-os` — modernized retro UI Kit, bitmap H1, dotted right-tick
- `chrome95` — authentic Win95, stacked inset bevels, dotted focus
- `lunar-hud` — slate + cyan HUD, `[ ]` corner brackets
- `lilac-stickers` — lavender canvas + dark sticker cards, dashed dividers
- `y2k-pop` — magenta + cyan, ::before title-bar with pixel chrome squares
- `pixel-crt` — royal purple + phosphor green LCD on numeric containers

### i18n

`src/lib/i18n.ts` ships ~200 keys with `en` + `es` (Rioplatense, voseo).
The picker in Settings → Language has three options: System (auto),
English, Spanish. Spanish covers all visible UI — only Rust-supplied
audit details and pure data (git hashes, MCP commands) stay untranslated.

### Workspace Sync

- One-click setup creates a private GitHub repo via `gh repo create`,
  clones to `~/.claude/.csk-sync/repo/`.
- Push: runs `engram export` + writes `projects.json` (catalog of repos
  with git remotes), commits via `git commit --amend`, force-pushes.
  Repo never grows beyond a single squashed commit.
- Pull on another machine: hard-resets, runs `engram import`, lists
  projects from `projects.json` so the user can clone them all to a
  target dir.

### Update channel

- App + gentle-ai updates checked once every 24h via `gh api` (uses
  the user's existing gh auth — no anonymous rate limits).
- Banners surface above content when an update is available; Settings
  card shows live status + manual "Check now".

---

## Pending — refactor batches

The codebase has been progressively decomposed. Two batches remain:

### Batch 4 — extract hooks from AppV3.tsx

`AppV3.tsx` still does data fetching + keyboard handling + theme cycling
inline. Extract to `src/hooks/`:

- `useAppData()` — owns the Promise.all fetch (projects + engram + audit
  + PRs), enrichment, error trap, refresh nonce. Returns `{ projects,
  prs, findings, goals, stats, loading, lastScanAt, fetchErrors,
  refresh }`.
- `useKeyboardShortcuts({ onTab, onRefresh, onOpenSettings, onCycleTheme })`
  — owns the global keydown listener (Ctrl+1..5, Ctrl+R, Ctrl+,, Ctrl+T).
- `useThemeCycle()` — wraps `nextV3Theme + applyAndPersistV3Theme` so
  AppV3 just calls `cycle()`.
- `useCompanion()` — name + image state + localStorage persistence
  (currently inline at the AppV3 top).

Goal: AppV3.tsx drops from ~330 lines to a thin orchestrator (~150).

### Batch 5 — services layer

`invoke<T>("ipc_name")` calls are scattered across views and AppV3.
Extract typed wrappers to `src/services/`:

- `services/projects.ts` — `scanProjects(windowDays)`, `engramKnownProjects()`,
  `enrichProjects(...)`, `openInVscode(path)`, `openPathInExplorer(path)`.
- `services/prs.ts` — `githubReviewQueue(limit)`, `openUrl(url)`.
- `services/audit.ts` — `runAudit()` (already has `parseAuditFindings` at
  the boundary).
- `services/cleanup.ts` — `cleanupPlan(olderThanDays)`, `cleanupApply(items)`.
- `services/claude.ts` — `listClaudeSkills()`, `countClaudeSkillUsage(names)`,
  `listMcpServers()`, `toggleMcpServer(name, source, enabled)`.
- `services/sync.ts` — `syncStatus()`, `syncSetup(name)`, `syncExport()`,
  `syncImport()`, `syncDisconnect()`, `syncListedProjects()`,
  `cloneProject(...)`.
- `services/updates.ts` — `checkAppUpdate()`, `checkGentleAiUpdate()`,
  `applyGentleAiUpdate()` (replace the raw invokes inside `useUpdates`).
- `services/workspace.ts` — `workspaceSummary()`.

Each wrapper validates input (string-stripping, bounds) at the JS side
before invoking, and unwraps the typed payload. Views go from
`invoke<Project[]>("scan_projects", { windowDays })` to
`scanProjects(windowDays)` — testable, mockable, single source of truth
for IPC names.

---

## Pending — feature backlog (from AUDIT.md pass-3, lower priority)

### Security (not blocking ship)

- **`git -C path`** in `git_last_commit` should use
  `Command::current_dir(path)` instead of `-C` to avoid the flag-injection
  edge case where path starts with `-`.
- **`engram_project_goal` path validation** — pipe path through
  `validate_open_path()`.
- **`run_audit` script integrity** — store SHA256 of `claude-audit.ps1`
  and check at runtime.
- **`github_review_queue` limit clamp** — `limit.min(500).max(1)`.
- **`gh` PATH shadowing** — use absolute path or signature check.
- **CSP missing directives** — add `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors 'none'`.

### Performance

- **Theme `@import` chain** — already converted to dynamic `import.meta.glob`
  in `lib/themes.ts`; verify each theme is its own chunk in the build.
- **Triple filter pass for audit counts** in OverviewView — collapse to
  a single `findings.reduce(...)`.
- **Inline arrow `onOpen` in `recentProjects.map`** — wrap
  `RecentProjectCard` in `React.memo` and stabilize handler.

### A11y / UX

- Y2K theme chip contrast — verify against AA at production sizes.
- Loading states — replace static text with skeleton loaders + `aria-busy`
  for >1s waits.
- Tooltip support on icon-only buttons (Palette + Cog in Overview).

### Code quality

- ESLint + Prettier wired into CI.
- Vitest setup for unit tests.
- `tsconfig.json` adds `noImplicitThis`, `exactOptionalPropertyTypes`,
  `forceConsistentCasingInFileNames`.

### Future (nice-to-have)

- Tauri Updater plugin proper — needs code signing key + release pipeline
  that publishes a signed `latest.json`. Until then, the current updater
  opens the GitHub release page (manual download).
- Auto-sync timer for engram — fire `sync_export` automatically on
  session end + every N minutes idle.
- Selective project sync — let the user pick which repos to include in
  `projects.json` instead of all-or-nothing.

---

## Branches

- **`desktopapp`** — active. Everything in this roadmap reflects this branch.
- **`main`** — legacy shell-kit history. Untouched since the
  reorganization commit.
- **`feat/tauri-rewrite`** — pre-restructure development branch (snapshot
  before `app/` → root promotion).

---

## Setup on a new machine

```powershell
git clone https://github.com/IP-Mattos/claude-startup-kit.git
cd claude-startup-kit
git checkout desktopapp
pnpm install
./dev.ps1                   # full dev (MSVC bootstrap + tauri dev)
# or:
pnpm typecheck              # frontend type check only
pnpm dev                    # browser preview at localhost:1420 (no Tauri)
```

External tools the app expects:
- `gh` (GitHub CLI, authenticated) — used by Sync setup, Update channel,
  PR queue.
- `git` — sync repo + project clone.
- `engram` — memory tool (sync export/import + workspace stats). Optional;
  the Workspace card degrades to "—" if not on PATH.
- `code.cmd` (VS Code) — open project from Projects tab. Optional.

Settings → Language defaults to System (detects from `navigator.language`).
Pick Spanish from the segmented control to override.

---

## Releases

`gh release create vX.Y.Z --target desktopapp --notes-file ...` with the
built `.msi` from `src-tauri/target/release/bundle/msi/`. Tag matches
`package.json` + `src-tauri/tauri.conf.json` `version`.
