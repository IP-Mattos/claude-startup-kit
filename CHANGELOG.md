# Changelog

## 0.1.50 — 2026-05-08

Cross-PC engram sync — move your memories between machines through any transport you want, no web service required.

### Added
- **Settings → "Sync between PCs"** (new card). Pick any folder once (a private git repo, a OneDrive folder, a USB drive, a NAS share — anything mountable as a path) and CSK exposes three buttons:
  - **Push** runs `engram sync --all` from the chosen folder, producing a single compressed chunk under `.engram/chunks/<hash>.jsonl.gz`. Deduped — only memories newer than the last chunk are exported. The chunk is yours; move it however you want.
  - **Pull** runs `engram sync --import` from the chosen folder, ingesting any new chunks engram finds there. Idempotent against memories already in the local DB.
  - **Status** runs `engram sync --status`, showing local-chunk count, remote-chunk count, and pending-import count so you can see at a glance whether there's something new on either side.
- **Three Tauri commands** in `src-tauri/src/lib.rs` — `engram_sync_push`, `engram_sync_pull`, `engram_sync_status`. Each shells out to the system `engram` binary with `cwd = sync_dir` and surfaces stdout/stderr verbatim to the renderer. No parsing — the UI shows whatever the engram CLI says, so future engram CLI changes don't need an app rebuild.
- **`csk-sync-dir` localStorage key** persists the user's folder choice across reloads.

### Why this approach
The user wanted a "brain" that follows them between PCs without a web service. Engram already has the entire cross-PC sync built in (`engram sync --all` exports a 5 MB compressed chunk for ~5000 memories; `--import` is dedup-safe). The right move was wrapping the existing CLI rather than reinventing transport. The folder is the contract — git, USB, OneDrive, NAS, scp'd, dropped in shared chat — engram doesn't care, CSK doesn't care.

### Out of scope (yet)
- Auto git push/pull when the sync folder is a git repo (one-click would be `engram sync --all && git add .engram && git commit && git push`). Easy to add in v0.1.51 if it earns its complexity.
- CSK panel state in the sync (pinned projects, snoozes, theme). Skipped because it's per-PC preference, not durable knowledge.
- Project-scoped sync (`engram sync --cloud --project X`). Default is `--all`; per-project is engram-native if needed.

## 0.1.49 — 2026-05-08

Audit findings render as a tight terminal-style table when the active theme is **data-dense**. Other themes keep the cards layout from before.

### Added
- **`useV3Theme()` hook in `lib/themes.ts`.** Subscribes to `body[data-theme-v3]` via MutationObserver so any view that branches markup on theme can react to live changes (Settings picker, Cmd+T cycle, etc.) without an explicit re-render trigger. Reusable across views.
- **`<FindingsTable>` component in AuditView.tsx.** Mirrors the `mockups/06-audit-dense-table.html` blueprint: SEV / CAT / HALLAZGO / ACCIÓN columns, group dividers between categories, severity-coloured short codes (no pill), ghost-outline action button per row keyed off `--v3-finding-action-color` (the same custom property the cards layout uses), `Hecho ✓` confirmation pill on success.
- **CSS for `.v3-audit-table` and friends** in `AppV3.css`. Theme-variable-driven (no hardcoded hex), so the table inherits the active theme's surface/border/text/severity tokens. The table is mounted only when `denseLayout` is true; CSS is base-styled to keep the rules theme-agnostic should we extend the table layout to other themes later.

### Implementation notes
The shared resolve flow — `handleResolve`, `runAction`, `confirmStrings`, `ConfirmModal` — stays in the `AuditView` parent. Only the markup forks. This keeps the confirm modal, action plumbing, error surfacing, and the "row pending" / "recently done" state all single-source-of-truth.

The default cards layout (`.v3-audit-groups`) is **untouched** — cards remain the experience for `light`, `dark`, `lunar-hud`, `pixel-crt`, etc. v0.1.48's theme-aware tints already made the cards work everywhere; v0.1.49 is purely additive for data-dense.

### Skipped on purpose
- The mockup's EDAD column (it implied per-finding age data the backend doesn't emit yet).
- Filter-chip restyling for data-dense (the existing `.v3-chip` already has a data-dense override that reads fine).
- Hide-on-filter for the divider rows. With single-category filters active, every row is the same category so the divider is informational; not worth the JSX gymnastics until someone complains.

## 0.1.48 — 2026-05-08

Audit finding cards now respect the active theme.

### Fixed
- **Card backgrounds and borders no longer hardcoded to Tailwind light-mode pastels** (`#FFFBEB` amber-50, `#FEF2F2` red-50, etc.). On dark themes (data-dense, dark) the cards painted as cream blocks against a black canvas and the title text rendered nearly invisible. Now driven by `--v3-{crit,warn,info,success}` (border) + `--v3-{...}-tint` (background) — every theme already declares these for exactly this kind of semantic surface, so cards inherit the right tone automatically.
- **Icon tints on warn / info / ok finding rows** were also half-hardcoded (e.g. `#B45309` text on `var(--v3-warn-tint)`). Replaced the hex literals with the matching theme variables so icons read correctly in dark themes too.
- **Severity → button colour mapping** (introduced in v0.1.45) was likewise mixed — `--v3-crit` was a variable, the others were hex. Unified to all-variables; the button now picks up data-dense's phosphor-bright palette, dark's standard Tailwind, or whatever the active theme defines.

### Why this matters
The audit panel was the last place in the app still wearing the `mockups/03-` light-mode skin from the early Tauri prototype. Themes like data-dense advertise a near-black canvas and the cream cards broke that promise on every WARN row. With this change, the audit visually integrates into the active theme instead of fighting it.

### Out of scope (yet)
The tabular SEV / CAT / PROYECTO / HALLAZGO layout in the data-dense mockup is a deeper restructure of `AuditView.tsx` and is not in this release. v0.1.48 is colour-only.

## 0.1.47 — 2026-05-08

Defense-in-depth on the SCRIPTS resolver shipped in v0.1.46.

### Fixed
- **`audit_resolve_delete` now refuses directory targets.** v0.1.46 extended the allowlist to non-kit files in `~/.claude/scripts/` and `scripts/lib/`, but the path-only check didn't gate by file type — `fs::rename` on a directory works on Windows and would have moved the entire tree to backup if a user ever clicked "Borrar" on an ad-hoc folder finding. Added `if canonical_target.is_dir()` rejection at the top of the resolver. Files-only is the only sane semantics for a one-click audit action.
- **`audit_scripts` now skips directories at scripts/ root.** Mirrors the existing `is_file()` guard in the lib/ scan. Without it, a folder like `scripts/experiments/` would emit a finding routed to `DeleteFile`, the resolver would reject it (per the fix above), and the user would see a confusing error after clicking "Borrar". Skipping the emit avoids the dead-end UX. The `lib` directory is still allowed because it's in `KIT_WHITELIST`.

### Why this matters
Even with v0.1.46's recoverable backup pattern, moving a whole directory tree on a single click is too sharp an edge for a routine audit action. The user that flagged this gets the safer behaviour without losing v0.1.46's "actually resolves" value: file findings still resolve in one click, directory findings disappear entirely.

## 0.1.46 — 2026-05-08

The audit row button now actually resolves the warning instead of just opening Explorer.

### Changed
- **SCRIPTS findings now route to `DeleteFile` action**, not `OpenInExplorer`. Clicking the row button moves the flagged file to `~/.claude/backups/audit-<timestamp>/` (recoverable), with a confirm modal preview of the exact path. Resolves the warning end-to-end without making the user file-juggle in Explorer first.
- **`audit_resolve_delete` allowlist extended** to accept any file directly under `~/.claude/scripts/` that isn't in `KIT_WHITELIST`, plus any file under `~/.claude/scripts/lib/` that isn't in `LIB_WHITELIST`. Both lists are now module-level consts so `audit_scripts` (which emits the findings) and `audit_resolve_delete` (which acts on them) stay in sync — adding a new kit script in one place automatically prevents the other from offering to delete it.
- **`audit.confirm_delete_message` copy fixed** to describe the actual behaviour. Old copy said "Permanently delete X. This cannot be undone." — the implementation has always moved files to a timestamped backup, so the copy was wrong.

### Why this matters
A "Resolver" button that doesn't resolve teaches users to ignore it. With this change, every WARN finding the audit emits has a one-click path to clean state. The settings.local.json delete (the only existing case) keeps its specific copy via the existing `audit.confirm_delete_settings_local_*` keys.

## 0.1.45 — 2026-05-08

### Changed
- **Audit row button now reads as part of its row's severity, not as a primary CTA.** Was solid theme-accent (e.g. data-dense's bright green) on every row, regardless of whether the finding was CRIT, WARN, INFO, or OK — the button shouted "primary action" at the user even for read-only stuff like "Show in Explorer" on a WARN row, and the green-on-amber colour pair clashed visually. Replaced with a ghost-outline button that picks up the row's severity colour (matches `.v3-level-*` pill backgrounds): amber on WARN, red on CRIT, blue on INFO, green on OK. Fills on hover. Done via a `--v3-finding-action-color` custom property scoped to each `.v3-finding-{level}` row, so theme accents stay untouched.

## 0.1.44 — 2026-05-08

Audit honesty — the row button told the user "Fix" / "Resolver" for clicks that did no fixing, and the SCRIPTS finding was self-flagging files the kit itself had just written. Both issues fixed in this release.

### Fixed
- **`audit_scripts` whitelist now covers kit-generated state files.** `KIT_WHITELIST` only listed kit *inputs* (the scripts) and missed the *outputs* the same scripts create at runtime — `.audit-summary.json`, `.audit-alerted-crit`, `.snoozed.json`, `.kit-last-auto-update`. Any user with the legacy hooks installed saw the audit flag those state files as "Non-kit file in ~/.claude/scripts/" on every run. Adding them to the whitelist stops the audit from eating its own tail.

### Changed
- **Per-action button labels in the audit row.** Replaced the single `audit.resolve` ("Fix" / "Resolver") with action-aware i18n keys mapped via `resolveLabelKey(action.kind)`:
  - `OpenInExplorer` → "Show in Explorer" / "Ver en Explorer"
  - `OpenInVscode` → "Open in VS Code" / "Abrir en VS Code"
  - `NavigateTo` → "Go" / "Ir"
  - `KillProcess` → "Kill" / "Matar"
  - `DeleteFile` → "Delete" / "Borrar"
  - `RestoreSettingsBackup` → "Restore" / "Restaurar"

  The generic "Fix / Resolver" was honest for the three destructive actions but lied for the navigation ones — clicking did nothing fix-shaped, just opened a folder/file/tab. The confirm modal still uses `audit.resolve` as `confirmLabel` because it only opens for the destructive trio.

## 0.1.43 — 2026-05-07

### Fixed
- **Projects view now picks up data/pipeline/research projects (was queued as v0.1.39 but never merged — finally landing).** User reported a folder (`New bd`) where they'd actively used Claude Code (13 MB of JSONL today) didn't appear, even though it has a README and 6 subfolders of work. Cause: `PROJECT_MARKERS` only listed code-package files (`.git`, `package.json`, `Cargo.toml`, etc.). Folders documented with a README but without a package manager were rejected.

  Added markers: `README.md`, `README.txt`, `README.rst`, `README`, `Makefile`, `Dockerfile`. Heuristic: a folder someone took the time to document or to add a build entry to is a project, regardless of language.

## 0.1.42 — 2026-05-07

VS Code workspaces as a project source — addresses the user's recurring complaint that the JSONL-driven Projects list misses folders they edit in VS Code without ever running `claude` inside.

### Added
- **`vscode_workspace_folders` IPC**. Walks `%APPDATA%\Code\User\workspaceStorage\<hash>\workspace.json` for every workspace VS Code knows about, decodes the `file:///` URL back to a Windows path, filters to folders that still exist on disk (VS Code keeps stale entries forever), returns deduped + sorted list. Pure filesystem read — no SQLite dep, no extra cost.
- **Projects view's "Más proyectos" section now unions VS Code workspaces with the disk scan**. Click "Buscar ahora" → backend runs both lookups in parallel → result is the union, deduped against the Claude-active list above. Anything VS Code has open that isn't a `.git` repo (data folders, scratch dirs, etc.) now surfaces with the same Open / Explorer buttons as everything else.

### Why this matters
User's words: *"antes el brief me mostraba los proyectos de vs code, eso quiero, obvio que si estan vinculados a engram me muestre como un resumen"*. Inverting the model fully (recents-driven instead of JSONL-driven) is a bigger pivot, but this PR ships the most impactful slice: every folder VS Code knows about is now reachable from CSK without having to run `claude` first.

### Implementation note
Used `workspace.json` (per-workspace storage), not `state.vscdb` (the SQLite global recents). VS Code maintains both. workspace.json is what we want — every folder ever opened. SQLite would need `rusqlite` as a Rust dep; kept it deps-free.

## 0.1.41 — 2026-05-07

Data-dense layout — second half of the mockup-to-real port. The `data-dense` theme now restructures the sidebar to include a flat project list (in addition to the colour/typography work from v0.1.36), tightens stat-card density, and adds a reusable `Sparkline` component for KPI strips.

### Added
- **Sidebar project list under data-dense theme.** Below the nav, a flat list of all Claude-Code-active projects shows up. Each row jumps to the project in VS Code on click. Truncates names with ellipsis, shows days-since-last-activity on the right in monospace. Sidebar widens slightly to 220 px so names fit. **Other themes hide the list entirely** via CSS (`display: none`) — the layout pivot is theme-gated, opt-in by picking the data-dense theme.
- **`<Sparkline data={...}>` component** — pure SVG, no library. Takes a number array (oldest → newest), normalises to its own min/max, draws a 1.25 px polyline at 64×18 by default. Currently a primitive ready for future KPI-history features; opt-in per consumer (StatCard takes an optional `trend?: number[]` prop). When passed, the sparkline shows; when omitted (current default — no historical store yet), it doesn't render. Avoids fake-looking trend lines until real history exists.
- **Stat-card density tightening for data-dense.** Smaller padding, smaller label font (9.5 px uppercase tracking), bigger value font (22 px), tabular-nums.

### Why no real sparkline data yet
None of the existing IPCs return time series — `run_audit` gives the current snapshot only, same for `scan_projects`, `github_review_queue`, `workspace_summary`. To fill the sparklines we'd need to persist run history (in engram or a local JSON). Tracked as a follow-up; the visual hook is in place for when it lands.

### Up next (if desired)
- Persist KPI history (audit runs, project counts) for real sparkline data.
- Table-style row layouts for Projects/PRs/Audit when on data-dense (currently still cards). Bigger refactor; deferred unless explicitly requested.

## 0.1.40 — 2026-05-07

Command palette layout — first half of the mockup-to-real port.

### Added
- **`Cmd/Ctrl+K` opens a command palette modal.** Linear / Raycast style. Universal across themes — works regardless of which theme you have active. Shows two sections:
  - **Navigate** — every sidebar tab (Overview, Projects, PRs, Audit, Cleanup) plus topbar tab (Claude, Sync, Companions, Settings) with their existing keyboard shortcuts as hints.
  - **Actions** — Run audit (`Ctrl+R`), Cycle theme (`Ctrl+T`).
  Fuzzy match on label + hint, ↑↓ to navigate, Enter to fire, Esc to close.
- **`command-palette` theme now restructures the sidebar to icon-only rail (~56 px).** Previously v0.1.36 only ported the palette + typography; the structural layout shift from `mockups/02-command-palette.html` was deferred. Now applied: when you pick the `command-palette` theme, the sidebar collapses to icons (labels become `aria-label` + native title for discoverability), the system-status footer collapses to just the colored dot, and a `⌘K` chip appears in the topbar to advertise the palette. Pick any other theme and the sidebar widens back to the standard layout — each theme decides.

### Component
- New `src/components/v3/CommandPalette.tsx` (~190 lines). Self-contained — receives `onTab` / `onRunAudit` / `onCycleTheme` callbacks from `AppV3.tsx`. No external fuzzy-match library; the catalog is small enough that a substring-rank scorer is plenty.

### Why universal (not theme-locked)
Cmd-K is a power-user keyboard shortcut. Hiding it behind a theme would punish users who like another theme but want quick command access. The theme controls *visual emphasis* (icon rail draws attention to it); the palette itself is always there.

### Up next (v0.1.41+)
The `data-dense` mockup involves a bigger restructure (sidebar with project list, KPI sparklines, table layouts). That's a separate PR pass.

## 0.1.38 — 2026-05-06

Drop the public-mirror release dance now that the source repo is public (since v0.1.36).

### Changed
- **`tauri.conf.json` updater endpoints** — added the source repo (`IP-Mattos/claude-startup-kit`) as the **primary** endpoint. The public mirror (`claude-startup-kit-releases`) stays as a **fallback** so already-installed clients pinned to it keep auto-updating until they hop to v0.1.38+. Tauri's updater tries endpoints in order and uses the first one that returns a valid `latest.json`.
- **`.github/workflows/release.yml` simplified** — removed the entire "Mirror signed assets to public release repo" step (~100 lines of PowerShell that downloaded `latest.json` from the private repo, rewrote URLs to the public mirror, and re-uploaded). Source-repo-only publish is direct; the mirror gets stale from this version forward but the existing v0.1.36/v0.1.37 mirror entries stay there for legacy clients.

### Removed
- `RELEASES_REPO_TOKEN` is no longer used by the workflow. The PAT can be deleted from the repo's Actions secrets if there's no other consumer.
- `PUBLIC_RELEASES_REPO` env var.

### Plan for the mirror repo
Keep alive a few releases (v0.1.38 → v0.1.42 ≈) so any user still pinned to the old endpoint can hop. After that, the mirror can be archived (kept for history) or deleted entirely. Track in a follow-up.

### Why now
- Source went public in v0.1.36.
- v0.1.36 + v0.1.37 already shipped to **both** repos (mirror still ran). New v0.1.38+ ships only to the source.
- Saves ~30s per release + removes a PAT dependency.

## 0.1.37 — 2026-05-05

Cleanup pass after the repo flipped from private to public.

### Sanitized
- **Replaced `darkm` (Windows account name) with `<user>` placeholder** in 3 places that were exposing the maintainer's local profile path: `CHANGELOG.md` lines 144 + 315 (release-note path examples) and `src-tauri/src/lib.rs:283` (a code comment illustrating an umbrella-dir example). No functional change — these were all narrative/illustrative strings.
- **Replaced "Mariano" greeting placeholder** in `mockups/01-zen.html` and `mockups/05-companion-first.html` with a generic "Buen día" — the mockups are now in the public repo and shouldn't address a specific person.

### Added
- **`build-local.ps1`** — manual escape hatch for building a Windows MSI without going through GitHub Actions. Bootstraps MSVC `vcvars64`, activates corepack pnpm, strips Git's GNU coreutils paths so MSVC's `link.exe` wins, and runs `pnpm tauri build`. Useful when CI is unavailable (billing pause, network outage); produces an unsigned bundle so the auto-updater can't install it — install once by hand. Documented in the script header.

## 0.1.36 — 2026-05-05

### Added
- **Two new V3 themes**, both ported from the design mockups under `mockups/`:
  - **`data-dense`** — Bloomberg / k9s / Datadog terminal. Near-black canvas, IBM Plex Mono on every meta/numeric surface, IBM Plex Sans on prose, hairline-only frames, no shadows, tabular nums, sand/coral/blue/green semantics. The theme's typographic spine is monospace.
  - **`command-palette`** — Linear / Raycast / VS Code Cmd-K. Cool blue-grey ink, JetBrains Mono everywhere except greetings/headlines, mint-green accent that reads like a focus cursor, Linear-style 10 px ring frames. Greetings stay sans for multi-line legibility.
- Both registered in `V3_THEME_ORDER` + `V3_THEME_OPTIONS` so they show up in the picker (Settings → Theme) and the keyboard cycle (`Ctrl/Cmd+T`). Each ships as its own lazy-loaded chunk via `import.meta.glob` (no initial-bundle weight).

### Note: themes vs layouts
The mockups under `mockups/04-data-dense.html` and `mockups/02-command-palette.html` change **layout** as well (sparkline KPIs, central ⌘K palette, dense tables). A theme can only retint surfaces — the structural changes from those mockups are NOT part of v0.1.36 and would need a separate UI pass.

## 0.1.35 — 2026-05-05

Cleanup batch — finishes the audit refactor + raises the GitHub repo cap.

### Refactored
- **`ProjectsView` no longer fetches `scan_projects` independently.** AppV3 now owns `windowDays` (lifted from ProjectsView's local state, still persisted to `csk-window-days` in localStorage) and fetches with it. ProjectsView consumes `projects` / `enrichment` / `loading` / `windowDays` / `setWindowDays` as props. The dropdown still drives a re-fetch — but only one, shared with Overview. Closes the last "intentionally left" item from v0.1.31's note.
- **AppV3 also exposes the full `enrichment` map** (was deriving only `goals`). ProjectsView reads git info + goals from the same map; Overview keeps reading the lighter `goals`.

### Changed
- **`gh_list_repos --limit 100` → `--limit 1000`.** Removes the 100-repo cap from the GitHub repo browser. Single-round-trip implementation stays simple; if anyone has >1000 repos a future PR can switch to `--paginate`. Comment in the IPC explains the trade-off.

## 0.1.34 — 2026-05-05

Engram Cloud awareness — completes the multi-machine sync UX.

### Added
- **`sync_remote_status` IPC.** Cheap `git ls-remote origin HEAD` against the user's sync mirror — no fetch, no working-tree update — comparing the returned SHA against `git rev-parse HEAD` locally. Returns a `SyncRemoteStatus` with `configured`, `behind`, `remote_sha`, `local_sha`, and a non-fatal `error` field (offline, transient gh auth issue → keeps sync usable manually).
- **"Otra máquina hizo push" banner in SyncCard.** Surfaces when `behind=true` with an Import CTA. Hides on its own once the user imports. Refreshes after every export/import action so it's always current.

### Why this matters
Before this PR, the multi-machine flow was: machine A exports → machine B has to remember to click Import. No nudge, no awareness. The user could go days without realizing remote engram has new memory. Now CSK pings the remote on mount and surfaces it.

### Why ls-remote and not full fetch
`ls-remote` is one round-trip and modifies nothing. A full `git fetch` would update `refs/remotes/origin/*` and could surprise the user later if they ran a manual git command in the sync repo. Awareness ≠ side effects.

## 0.1.33 — 2026-05-05

Disk scan for `.git` repos — feature.

### Added
- **"Más repos en disco" section in the Projects tab.** Below the Claude-Code-activity list, a new section walks common dev parent dirs (`~/Desktop/Code`, `~/OneDrive/Desktop/Code`, `~/Desktop`, `~/OneDrive/Desktop`, `~/Documents/Code`, `~/Documents/GitHub`, `~/Code`, `~/dev` — only the ones that exist) for `.git/` directories. Click "Buscar ahora" to run the walk; results filter out anything already in the Claude-active list. Each row has Open / Explorer buttons (same shape as the existing rows) so the user can act immediately. Closes the gap the user hit on v0.1.28: "claude-startup-kit doesn't appear because I never ran `claude` inside it."
- **`disk_scan_git_repos(roots, max_depth?)` IPC** — bounded recursive walk that stops descending once a `.git` is found (no submodule double-counting). Default depth 4, capped at 8 in the IPC. Prunes `node_modules`, `target`, `dist`, `build`, `.next`, `.cache`, `.venv`, `vendor`, `AppData`, etc. so the walk stays under a couple of seconds even on populated trees. Returns each repo's `path`, `name`, and `origin` remote (when present).
- **`default_disk_scan_roots()` IPC** — resolves a sensible starting list of dev parent dirs from `dirs_home()`. Returns only paths that exist on the user's machine, so the renderer doesn't have to enumerate non-existent candidates.

### Why bounded depth + prune list
Unbounded walks of `~` hit `node_modules` (~100k files), `AppData`, `Library`, etc. and become unusable. Combined with the prune list, the walk stays in user-code territory.

### Why we stop descending once `.git` is found
Avoids surfacing every git submodule as a separate "project". The user wants their top-level repos, not the `node_modules/foo/.git` pseudo-repo.

## 0.1.32 — 2026-05-05

GitHub repo browser — feature.

### Added
- **"Todos tus repos de GitHub" card in the Sync tab.** Lists every repo `gh` can see (own + collaborator) — independent of sync metadata. Per-row Clone button reuses the existing `clone_project` IPC, so the path-traversal + scheme + flag-injection guards from v0.1.16 still apply. Search filter matches against name, full-name, and description. Privacy badge on private repos.
- **`gh_list_repos` IPC** — runs `gh repo list --limit 100 --json …`, parses into a renderer-friendly `GhRepo` shape (`name`, `full_name`, `description`, `url`, `clone_url`, `updated_at`, `is_private`). Detects unauthenticated `gh` and surfaces a clear "corré `gh auth login`" hint instead of leaking gh's multi-line stderr.

### Why this is a separate card from "Proyectos en este remoto"
Different scope and trust model:
- **Sync card** — projects in YOUR sync mirror (the engram-cloud repo). Curated set, syncs metadata between your machines.
- **GitHub repos card** — every repo the `gh` user can see, including ones you've never touched in CSK. Lives outside the sync flow so it works without sync setup.

### Limit: 100 repos
`gh repo list` paginates beyond that; we don't chain pages today. If a user has more than 100 repos we'll add `--paginate` and a streaming loop later — flagged in the IPC comment.

## 0.1.31 — 2026-05-05

Audit-deferred refactor: kill the AppV3-vs-views double-fetch.

### Refactored
- **`AuditView` no longer fetches `run_audit` independently.** AppV3 had already fetched the same endpoint on mount for the Overview's CRIT/WARN counters; AuditView duplicated the call when the user navigated to its tab. Now accepts `findings` / `loading` / `onRefresh` props from AppV3, drops its own state + effect. The "Re-ejecutar" button bumps AppV3's `refreshNonce` via `onRefresh`, refreshing the workspace once instead of just AuditView's slice.
- **`PrsView` no longer fetches `github_review_queue` independently.** AppV3 used to fetch with `limit=20`; PrsView fetched again with `limit=50`. Now AppV3 fetches `limit=50` once, PrsView consumes via props, Overview slices what it needs from the same data — one network/IPC call instead of two per session.

### Note (intentionally left)
- `ProjectsView` still fetches independently because it has a dynamic `windowDays` parameter that AppV3 holds at a fixed 14. Lifting the dropdown state up to AppV3 is the natural follow-up but out of scope for this PR.

## 0.1.30 — 2026-05-05

CSP hardening — security tier from the deferred audit list.

### Fixed
- **Dropped `'unsafe-inline'` from `script-src`.** The CSP now reads `script-src 'self'` instead of `script-src 'self' 'unsafe-inline'`. `'unsafe-inline'` allows any inline `<script>…</script>` to execute, which defeats most of CSP's anti-XSS value: a renderer-side injection (XSS in a third-party dep, accidentally `dangerouslySetInnerHTML` of attacker-controlled HTML, etc.) could land arbitrary script in the WebView. With this change, only scripts served from `'self'` (the bundle root) execute — inline payloads are blocked by the WebView before they run.

### Refactored
- **Anti-FOUC theme bootstrap moved from inline `<script>` in `index.html` to `public/anti-fouc.js`** so the new CSP can take effect. Loaded via `<script src="/anti-fouc.js"></script>` in `<head>` ahead of the main bundle — same paint timing as before, no flash regression. Vite copies `public/*` into the bundle root verbatim, so `'self'` covers it.

### Note (out of scope)
- `style-src 'unsafe-inline'` stays for now. Removing it requires nonce/hash on every inline `style` attribute and `<style>` tag emitted by React + UI helpers, which is significant churn for a smaller attack surface than scripts. Tracked for a later pass.

## 0.1.29 — 2026-05-05

Audit-deferred robustness batch — four resilience fixes against upstream drift, race conditions, and IPC blocking.

### Fixed
- **`engram_known_projects` no longer blocks the IPC thread on cold cache.** Was a sync `fn` calling `known_projects_cached()` which on cache miss shells out to `engram projects list` — 1-3s on slow disk or first run after machine boot. The sync IPC blocked Tauri's IPC thread, freezing the UI on first AppV3 mount. Now async + `spawn_blocking`.
- **`apply_stack_update` taskkill list is dynamic.** Was hardcoded to `["engram", "gga"]` (v0.1.14). When gentle-ai upstream adds a new managed tool that runs as a background process (e.g. `opencode-*`), the upgrade silently failed with a "rename" error from a locked binary. New `discover_stack_tool_names()` parses `gentle-ai update` to get the actual installed list. Falls back to the hardcoded names if discovery fails.
- **`apply_stack_update` taskkill→upgrade race window widened from 800 ms to 1500 ms.** Defender's real-time scan was observed holding handles to just-killed binaries on contended machines, causing the rename inside `gentle-ai upgrade` to fail with "Access is denied". 1.5 s is empirically enough.
- **Friendly error when an upgrade fails because a binary is locked.** Was leaking the raw stderr ("Access is denied. (os error 5)") to the UI. Now returns: *"Una herramienta del stack tenía un binario bloqueado durante el upgrade. Cerrá Claude Code y todas las terminales abiertas, y dale 'Actualizar todo' otra vez."*
- **`check_stack_update` parser sentinel.** If `gentle-ai update` printed bracketed table-shape lines (`[ok] foo …`, `[--] bar …`) but `parse_gentle_ai_update_line` matched zero rows, we used to silently return an empty list — looked like "no managed tools" to the user even though tools were there. Now returns a distinct error pointing at upstream format drift, with hint to upgrade gentle-ai.

### Added
- **`discover_stack_tool_names(program)`** helper — runtime discovery of managed-tool names from `gentle-ai update` output.

### Renamed
- `STACK_TOOL_PROCESS_NAMES` → `STACK_TOOL_PROCESS_NAMES_FALLBACK` to clarify it's now the fallback path, not the source of truth.

### Out of scope (deferred)
- `engram_project_goal` returns silent `None` on engram failure (indistinguishable from "no goal saved"). Real fix is changing the return shape — bigger refactor with frontend impact.
- AppV3 + view double-fetch refactor (lift state to context).

## 0.1.28 — 2026-05-05

### Fixed
- **Projects view shows monorepos now**. User reported only 2 of ~7 active projects were appearing. Root cause: `scan_projects` required a project marker (`.git`, `package.json`, etc.) on the folder itself. Folders like `PetsNew/` (a Laravel + landing-page meta-project where the user runs Claude Code at the parent but each child — `pets/composer.json`, `landing/index.html` — carries the marker) were filtered out.

  New filter logic:
  1. **Hard-reject if the cwd is a known umbrella** (`~`, `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Music`, `~/Pictures`, `~/Videos`, the same set under `~/OneDrive/`, plus `~/OneDrive/Desktop/Code`). All paths derived from `dirs_home()` so they're universal across users.
  2. **Accept if the folder has a marker OR any immediate subfolder does** (the monorepo case).

  Step 1 is necessary because step 2 would otherwise admit `Desktop` as a "monorepo" — every dev child under it has `.git`. The umbrella blocklist is the explicit cutoff.

### Note (not a bug, addressed in user-facing message)
- The Sync card's "Proyectos en este remoto" list shows only **local git repos with a configured remote**. If a user has 8 GitHub repos but only 2 cloned locally with `origin` set, only those 2 appear. Sync is for syncing project metadata between the user's machines, not for surfacing arbitrary GitHub repos. The latter would be a separate feature (`gh repo list` browsing) — not shipped in v0.1.28.

## 0.1.27 — 2026-05-05

### Fixed
- **Sync no longer fails with `Author identity unknown`** on machines where the user never set `user.email` / `user.name` globally. CSK was running plain `git commit` in the sync repo, which git refuses without an identity. New `git_commit_in` helper passes the identity inline via `-c user.name=… -c user.email=…` (CSK-bot values: `Claude Startup Kit Sync <csk-sync@local>`) so the commit succeeds without us touching the user's global git config — same shape as the inline identity we use for release tags. Applied to all three commit callsites: `init: csk sync` first commit, `sync` amend, and the `sync` fallback when there's no prior commit.

## 0.1.26 — 2026-05-05

### Fixed
- **No more flashing/sticky cmd window when opening a project**. `open_in_vscode` was launching `code.cmd` (a CLI wrapper that runs `Code.exe cli.js …`) which flashes a console window and on some setups stays visible until cli.js exits — sometimes never. Switched to spawning `Code.exe` directly with `silent_command` (`CREATE_NO_WINDOW`). Mirrors what Explorer's "Open with Code" registered handler does (queried from `HKCU\Software\Classes\Applications\Code.exe\shell\open\command`). New `resolve_vscode_exe()` helper checks the registry first, falls back to `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` and the two `Program Files` install dirs. Dropped the `--` end-of-options separator since `Code.exe` doesn't need it and `validate_open_path` already rejects leading-`-` paths.

## 0.1.25 — 2026-05-05

ROOT CAUSE for the recurring **Claude Code sidebar fails to load** bug the user reported across v0.1.21, v0.1.22, v0.1.23, and v0.1.24.

### Fixed
- **`validate_open_path` strips the `\\?\` UNC prefix that `canonicalize` adds on Windows.** Every consumer (`open_in_vscode`, `open_path_in_explorer`) was handing VS Code paths like `\\?\C:\Users\<user>\OneDrive\Desktop\Code\<project>`. VS Code wrote those verbatim into its workspace recents — visible directly in the user's "Recent" list mixed with normal `C:\...` entries. When the Claude Code extension activates and iterates `vscode.workspace.workspaceFolders`, the inconsistency crashes the iterator with `TypeError: V is not iterable` and the `claudeVSCodeSidebarSecondary` view refuses to load (see [anthropics/claude-code#16634](https://github.com/anthropics/claude-code/issues/16634), [#34678](https://github.com/anthropics/claude-code/issues/34678)). Same project opened from Explorer's "Open with Code" never reproduces because Explorer doesn't go through `canonicalize` and produces clean paths.

### Why we shipped 4 wrong fixes first
- v0.1.23 PATH augmentation (right call, wrong cause)
- v0.1.24 detach via `cmd /c start` (right call, wrong cause)
- Two assumptions about extension state and process trees that distracted from the actual evidence: the user's recents list literally showed paths with `\\?\` prefix on the broken entries.

CLAUDE.md already documented the rule: *"`\\?\` UNC prefix is stripped after `fs::canonicalize` on Windows so paths round-trip cleanly through IPC and back into git/explorer."* The codebase has a `strip_unc_prefix` helper used in 1 of 2 canonicalize call sites — `validate_open_path` was the one that forgot to call it.

## 0.1.24 — 2026-05-05

Audit-driven CRIT batch from a 12-finding review. Same theme as v0.1.23: stop the **inconsistent-state** class of bugs the user has been hitting (banner shows X, action does Y; cache shows old, reality is new; cryptic error vs actionable message).

### Fixed
- **VSCode opens detached now** — was launched via `Command::new("code.cmd")` which left VS Code in CSK's process tree. The Claude Code extension's `claudeVSCodeSidebarSecondary` view failed to bootstrap when opened from CSK but loaded fine when opened from Windows Explorer. Switched to `cmd /c start "" code.cmd -- <path>` which detaches the same way `ShellExecute` does. Same `--` end-of-options guard, no security regression.
- **Mirror-skew has its own error now** — `apply_app_update` used to return `"no update available"` whenever the renderer-facing banner (GitHub Releases REST API) and the Tauri updater (`latest.json` on the public mirror repo) disagreed during the brief publish window. Now returns `"MIRROR_LAG: el espejo todavía no publicó esta versión. Probá de nuevo en 1-2 min."` so the user knows to retry instead of opening a bug.
- **PATH augmenter completed** — v0.1.23 missed `gh` (`%PROGRAMFILES%\GitHub CLI\`), `git` (`%PROGRAMFILES%\Git\cmd\` and `bin/`), `powershell` (`%WINDIR%\System32\WindowsPowerShell\v1.0\`), and `System32` itself. All added — the entire Sync flow, PR queue, update channel, and gentle-ai self-upgrade are immune to stripped-PATH inheritance now, not just engram and gentle-ai.
- **Cache invalidation on mutating IPCs** — `apply_gentle_ai_update`, `apply_stack_update`, `sync_import`, `toggle_mcp_server`, and `restore_settings_backup` were all leaving the 5-min `WORKSPACE_SUMMARY_CACHE` and `KNOWN_PROJECTS_CACHE` stale after mutating the underlying state. Now each one busts the relevant cache before returning.
- **WorkspaceCard re-fetches on `csk:workspace-invalidate`** — even with the backend cache busted, the right-panel widget was bound to its mount-time state. Now listens for a custom event dispatched by `useUpdates.applyGentleAi` and `useStackUpdates.applyAll` so the widget updates immediately.
- **`spawn X: program not found` errors translated** — was leaking raw Windows IO errors to red banners (`spawn engram: The system cannot find the file specified. (os error 2)`). New `format_spawn_error` helper detects `ErrorKind::NotFound` and emits a localized hint pointing at the most likely cause (recent install + stale PATH). Applied to all 13 shell-out callsites.

### Added
- **`format_spawn_error(program, err)`** helper in `lib.rs`. Reusable for any future shell-out.
- **`invalidate_known_projects_cache()`** and **`invalidate_workspace_summary_cache()`** helpers. Tiny but make every mutating IPC's responsibility explicit and grep-able.
- **`audit_resolve_delete` IPC** with explicit allowlist (currently just `~/.claude/settings.local.json`). Moves the file to `~/.claude/backups/audit-<unix-ts>/` instead of permanent delete so the user can recover.

### Fixed (audit Resolver UX)
- **DRIFT/`settings.local.json` Resolver actually resolves now** — was mapped to `OpenInVscode`, so the user got a "Done ✓" badge but the finding kept reappearing on every audit run because nothing on disk changed (user reported: "le doy resolver y dice hecho y luego vuelve a pedir resolve, no hay feeling, no hay indicador, se abre vscode pero qué haga ahí? eso debería ser automático"). Now mapped to `DeleteFile` → confirm modal with finding-specific copy → file moved to backups → audit refresh → finding gone. Reversible (file is in backups, not deleted).
- **Confirm modal for `settings.local.json` is finding-specific** — was the generic "Permanently delete X?" copy. Now explains exactly what the local override does, that the local permissions are lost, and where the file goes.

## 0.1.23 — 2026-05-05

Systemic fix for the **"program not found"** class of errors that kept regressing on different IPCs (`engram` from sync's clone, `code.cmd` from Audit's "Resolver" and Projects' "Abrir") after auto-updates.

### Root cause
After a Tauri auto-update, the new app instance can inherit a `PATH` that's missing per-user install dirs (`%LOCALAPPDATA%\engram\bin`, `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin`, `~\go\bin`, `~\bin`, `%APPDATA%\npm`). Each shell-out — `engram`, `code.cmd`, `git`, `gh`, `bash` — could then fail with "program not found" even though the same command works from a fresh terminal. We had been patching this **per tool** (`resolve_gentle_ai` in v0.1.11, `resolve_managed_tool` in v0.1.19/v0.1.21) but new shell-outs kept regressing.

### Fixed
- **Process `PATH` augmented at boot** via new `augment_path_with_user_bin_dirs()`, called as the first thing in `run()` before the Tauri builder spins up. Prepends well-known user-scoped bin dirs to `PATH` if they exist AND aren't already there. Every `Command::new(<bare-name>)` downstream — sync's `engram`, audit/projects' `code.cmd`, gentle-ai, gh, git, bash — now resolves correctly without needing per-tool resolvers.
- All paths are env-var derived (`LOCALAPPDATA`, `APPDATA`, `USERPROFILE`/`HOME`, `PROGRAMFILES`, `PROGRAMFILES(X86)`) so this is universal across machines.
- No-op on machines where every dir is already in `PATH` (e.g., users who configured everything via system settings).

## 0.1.22 — 2026-05-05

Drop the `KIT` audit category. It was a verbatim port of the legacy PowerShell kit's `claude-audit.ps1` that checked for a `~/.claude/scripts/.kit-version` marker file the legacy installer dropped. With the legacy kit retired (it lives under `legacy/` and is no longer the shipping product), the check became a permanent false positive: every fresh user saw "No .kit-version marker — kit may not be installed" and the **Resolver** button failed with "kit config not found at C:\\Users\\\\.claude\\scripts\\startup-kit-config.json" because `reinstall_kit` was hardcoded to drive the legacy installer.

### Removed
- **`audit_kit`** function and its call site in `run_audit_blocking`.
- **`KIT` arm** in `infer_action`.
- **`reinstall_kit` IPC** (Rust async command, registered handler, frontend `invoke` call).
- **`AuditAction::ReinstallKit`** Rust enum variant.
- **`{ kind: "reinstall_kit" }`** TypeScript union member, the `KNOWN_ACTION_KINDS` entry, and the matching `normalizeAction` arm.
- **`PendingConfirm` arm** for `reinstall_kit` and the `confirmStrings` case.
- **`audit.confirm_reinstall_*`** i18n keys.

### Note
`.kit-version` stays in `KIT_WHITELIST` of `audit_scripts` — it's a benign filename match that prevents the marker from being re-flagged as a "non-kit file" if a user does still have the legacy kit installed alongside the Tauri app.

## 0.1.21 — 2026-05-05

Two follow-ups to the v0.1.20 install wizard release.

### Fixed
- **Install wizard auto-closes** — was using `cmd /k` which kept the new console window open after the wizard exited (user had to close it manually). Now uses `cmd /c <wizard> & timeout /t 8 /nobreak` with `CREATE_NEW_CONSOLE`: wizard runs, then a visible 8-second countdown, then the window auto-closes. `/nobreak` so the countdown can't be skipped by accident.
- **`gga` (and any tool installed as a PowerShell wrapper or .cmd shim) now detected** — the v0.1.19 detection-override only looked for `<name>.exe` on PATH + a small list of fallback dirs. gentle-ai's installer drops `gga` as a bash script next to a `gga.ps1` wrapper in `~\bin\`, so the resolver missed it. Now scans `.exe` / `.cmd` / `.bat` / `.ps1` extensions and adds `%APPDATA%\npm\` (npm-global target) to the fallback dir list. `read_managed_tool_version` invokes via `cmd /c` for `.cmd`/`.bat` and `powershell -NoProfile -Command "& '<path>'"` for `.ps1`.

## 0.1.20 — 2026-05-05

Per-row "Instalar" button on the Stack tools card. Closes the missing-affordance gap when gentle-ai reports a managed tool as not installed — before this you could see "No instalada" but had no way to act on it from the app.

### Added
- **`open_stack_install_wizard` IPC** — spawns `gentle-ai install` (the upstream interactive wizard) in a new visible console window via `cmd /c start "" cmd /k`. Fire-and-forget so CSK stays responsive; `/k` keeps the window open after the wizard exits so the user reads the final summary. There's no `gentle-ai install <name>` upstream — the wizard configures the whole catalog at once, so every per-row "Instalar" button opens the same flow.
- **`StackToolRow` per-row "Instalar" button** on `not_installed` rows. Visually mirrors the existing per-row "Update now" affordance (`v3-update-row-action` class). Tooltip explains it opens gentle-ai's wizard.
- **`useStackUpdates.openInstallWizard`** — invokes the IPC, surfaces failures via the existing `error` field.

### Why not per-tool installer URLs
Hardcoding `irm <url> | iex` per tool is brittle — if Gentleman-Programming moves an installer, CSK starts lying. Delegating to the upstream wizard keeps the source of truth where it belongs.

## 0.1.19 — 2026-05-05

Detection-override for the Stack tools card. gentle-ai's `update` table is the source of truth for *versions*, but its detector occasionally reports a tool as `[--]` (not installed) when the binary is reachable on the user's machine — engram and gga have both hit this. Without a fix, the UI claims "No instalada" right next to a working `engram --version`.

### Fixed
- **`check_stack_update` overrides false `not_installed` rows** by walking PATH + well-known install dirs the same way `resolve_gentle_ai` already does, then probing `<binary> --version` / `<binary> version`. If a real semver comes back, the row's state is recomputed against `latest` (`up_to_date` vs `update_available`). Fixes engram showing as "No instalada" on machines where `engram --version` works from a fresh terminal.

### Added
- **`resolve_managed_tool(name)`** — generic resolver mirroring `resolve_gentle_ai`. PATH walk first; falls back to `%LOCALAPPDATA%\<name>\bin\`, `~\.local\bin\`, `~\go\bin\`, `~\bin\`, `~\AppData\Local\<name>\bin\`. All paths derived from env vars — no machine-specific absolutes.
- **`read_managed_tool_version(program)`** — best-effort version probe trying both `--version` and `version`, scanning stdout then stderr for the first semver triplet. Used by the override path; reusable for any future stack-tool detection.

### Refactored
- **`extract_semver(text)`** factored out of `read_gentle_ai_version`. Same logic, now shared with the override path.

## 0.1.18 — 2026-05-05

INFO-tier cleanup pass from the 5-agent audit (memo: engram #875). The two deferred WARN items (AppV3 double-fetch refactor + CSP hardening) move to v0.1.19 — they need careful work that doesn't fit cleanly in a cleanup release.

### Changed
- **`apply_stack_updates` and `check_stack_updates` renamed** to `apply_stack_update` / `check_stack_update` for symmetry with `apply_app_update`, `apply_gentle_ai_update`. JS callsites in `useStackUpdates.ts` updated; `invoke_handler!` registration follows.
- **`scan_projects` returns `Result<Vec<Project>, String>`** instead of swallowing join errors with `unwrap_or_default()`. The frontend `AppV3.tsx` already wrapped the call in `trap("Projects", [])` so backend errors now flow into the existing fetch-error banner instead of masquerading as an empty list.
- **`audit_kit` surfaces IO errors as a WARN finding** instead of pretending success with an empty version string. If `.kit-version` is unreadable (permission, file lock), the audit panel now shows the underlying error.

### Fixed
- **`AuditView` "Done ✓" timeout cancelled on unmount AND on rapid re-fire** — used to leak a `setRecentlyDoneId(null)` setState onto an unmounted component (React 19 dev warning), and a fast second action could clobber a fresh badge. Now tracked in a `useRef`, cleared in cleanup and at the start of each new action.
- **`useUpdates` per-channel error state** — was sharing one `error` field, so a transient `gentle-ai` failure overwrote a still-relevant app-update error and vice versa. Split into `appError` / `gentleAiError`. Settings panel renders both independently.
- **`toggle_mcp_server` plugin branch no longer silently no-ops** when `enabledPlugins` isn't an object — returns `Err("enabledPlugins is not an object")` so the renderer can react.

### Removed
- **5 dead helpers** in `src/lib/format.ts`: `activityLabel`, `activityLabelEn`, `tierClass`, `hexId`, Spanish `friendlyError`. Unused since the v3 layout migration.
- **Stale "moved to" relocation comments** in `AppV3.tsx` from a previous refactor. Were duplicated and added noise without informing.
- **`useStackUpdates.lastApplyOutput`** — exposed in the hook contract but never consumed by any consumer. Dead surface area.

### Refactored
- **`IS_TAURI` extracted** to `src/lib/env.ts`. The literal `typeof window !== "undefined" && "__TAURI_INTERNALS__" in window` was duplicated VERBATIM in 12 files. Now one source of truth; all 12 files import from `env.ts`.
- **`audit.ts:13`** — `let unknownLevelsLogged` → `const`. Was never reassigned, only mutated via `.add`.

### Out of scope (v0.1.19)
- AppV3 + view double-fetch refactor (lift state to context).
- CSP `'unsafe-inline'` removal with nonce/hash.

## 0.1.17 — 2026-05-05

WARN-tier follow-up to the v0.1.16 audit-pass. Performance, security, and accessibility wins; INFO-tier cleanup lands in v0.1.18.

### Performance
- **`audit_disk` does ONE recursive walk** of `~/.claude` instead of 5. Previously it recursed once for total size, then again for `projects/`, `logs/`, `backups/`, then a fifth time for big-JSONL detection. Single pass now accumulates total + per-bucket totals + collects large JSONLs in one shot. On a multi-GB tree that's roughly ⅕ the syscall cost per audit run.
- **`workspace_summary` cached for 5 minutes** (mirroring the existing `KNOWN_PROJECTS_CACHE` pattern). The right-panel WorkspaceCard used to fire `engram` + a 200-JSONL scan on every mount (3-5 s wall time). The IPC now early-returns from cache.
- **`count_skill_usage` cached for 5 minutes.** Used by the WorkspaceCard's "skills used" stat. Was rescanning ~400 MiB of JSONL substrings every mount with no cache.
- **`enrich_projects` semaphore-capped at 8 concurrent workers** via `tokio::sync::Semaphore`. With 50+ projects, the unbounded fan-out raced the Tokio blocking pool and queued behind a single-threaded engram CLI.
- **`read_last_n_lines` reads from EOF, capped at 256 KiB.** `audit_logs` was loading the whole `startup-kit.log` into a Vec on every audit run. Now it seeks from the end in 8 KiB chunks until it has N newlines or hits the cap.

### Security
- **`sync_setup` rejects `repo_name` with `/`, `\`, or leading `-`** — same shape as the v0.1.16 `clone_project` validation. Closes a confused-deputy with the user's `gh` PAT (a renderer-supplied `org/name` would have overridden the resolved gh user).
- **TODO marker added on `GENTLE_AI_INSTALLER_URL`** — the `irm install.ps1 | iex` flow targets `main` branch unsigned. Pinning to a commit SHA needs upstream coordination; flagged inline so we don't lose it.

### Audit
- **"Large JSONL" findings now include the full path in detail** so `infer_action`'s `extract_windows_path` resolves to `OpenInExplorer`. Previously the title only had the filename so the explorer-open arm was dead code (fell through to `NavigateTo cleanup`).

### Accessibility
- **Click-target sizes ≥ 32 px** on `.v3-link`, `.v3-finding-resolve`, and `.v3-btn-icon`. WCAG 2.5.5 / 2.5.8. The link variant ("Buscar ahora", "Ver todos") is used as a button across Settings / Overview / Sync / Claude tabs.
- **`.v3-recent-ago` contrast fix** — was `--v3-text-4` (`#9CA3AF`) on white, 2.85:1, failing WCAG AA. Now `--v3-text-3` (`#6B7280`, 4.83:1).
- **`.v3-update-row-label` no longer overflows** when paired with long Spanish status strings on the right side. Added `min-width: 0; flex: 0 1 auto;`.

### Out of scope (v0.1.18)
- AppV3 + view double-fetch refactor (lift to context) — needs a careful pass to avoid regressions.
- CSP hardening (`'unsafe-inline'` removal with nonce/hash) — needs Tauri 2 spec verification first.

## 0.1.16 — 2026-05-05

Audit pass — six critical findings from the 5-agent parallel sweep are fixed in this release. WARN-tier and INFO-tier items land in v0.1.17 / v0.1.18.

### Fixed (security)
- **Path traversal in `clone_project`** — the renderer-supplied `name` flowed through `Path::join`, which on Windows replaces the base when the segment is absolute (`C:\...`) and walks up the tree on `..`. A tampered sync mirror could feed `name = "..\\Startup\\foo"` and write outside the user's chosen target dir. Now we reject path separators / `..` / `:` / leading `-` in `name`.
- **`git clone` flag injection in `clone_project` and `sync_setup`** — the URL was passed to `git clone` without `--`, so `--upload-pack=evil` style strings were parsed as flags (historic git RCE class). Now we insert `--` before the URL and reject schemes other than `https://`, `git@`, `ssh://`, `git://`.

### Fixed (functionality)
- **Project goals never appeared on Overview / Projects** — `enrich_projects` returned `Vec<EnrichedProject>` from Rust but the renderer typed it as `Record<string, EnrichedProject>` and looked up by `enrichment[p.path]`, silently getting `undefined` every time. The Rust side now returns `HashMap<String, EnrichedProject>` so the renderer's lookup actually works.
- **"Resolver" button never appeared on non-kit-script findings** — `audit_scripts` emitted "Non-kit file in ~/.claude/scripts/: …" at INFO level, but `push_finding` skips action inference for INFO. Bumped that finding to WARN, added the matching `OpenInExplorer` arm in `infer_action`, and routed `~/.claude/scripts/` paths through `claude_path_string` for proper canonicalization.
- **`check_stack_updates` / `apply_stack_updates` failed silently after auto-update** — both shelled out to bare `gentle-ai` instead of `resolve_gentle_ai()`. The Tauri auto-updater hands the new app instance a PATH that's missing `%LOCALAPPDATA%\gentle-ai\bin\` so the spawn returned ENOENT, the Stack tools card showed "No managed tools detected", and "Update all" silently no-op'd. Both now use the existing `resolve_gentle_ai()` helper.

### Fixed (UX / accessibility)
- **Filter chip INFO color clashed with WARN** — both rendered amber when active so toggling the filter felt unresponsive. Now `chip-info.active` uses the calm blue `--v3-info` token like the row tints.
- **`<ConfirmModal>` did not trap focus** — Tab escaped the dialog into background controls, and `aria-modal="true"` was lying. Added: focus moves to Cancel on open, Tab/Shift-Tab cycles between Cancel and Confirm only, focus restores to the previously-active element on close.

### Projects scanner — also from v0.1.15
- `scan_projects` now requires a project-marker file (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `requirements.txt`, `pubspec.yaml`, `mix.exs`, `tsconfig.json`, `deno.json`, `.project`, `*.sln`) so umbrella dirs like `Desktop` / home don't show up as workspaces.

## 0.1.15 — 2026-05-05

### Fixed
- **"Update all" did nothing when the only pending update was gentle-ai itself.** `gentle-ai upgrade` cannot replace its own running binary on Windows; it logs `manual update required` and exits 0 with `1 skipped`. CSK was returning that output verbatim and the table showed "everything done" while gentle-ai stayed on the old version. `apply_stack_updates` now detects the self-skip and falls back to running `irm install.ps1 | iex` (same flow as the per-row gentle-ai update button), all in one click.
- **Stack-update parser absorbed the install hint into the `latest` version string.** When gentle-ai upstream updated its `update` output to inline the install command after the version (`latest: 1.25.6 irm https://...install.ps1 | iex`), the greedy `trim()` captured the whole hint and the UI rendered `v1.25.5 → v1.25.6 irm https://raw.githubusercontent.com/...`. Now we tokenize and take only the first whitespace-delimited word for both `installed:` and `latest:`.
- **Projects tab listed umbrella directories as workspaces.** Claude Code records a session at every cwd you launch it from — paths like `C:\Users\<user>\OneDrive\Desktop` or `~` produced JSONL entries CSK was scanning into "projects". Clicking "Open" then attached VS Code to the whole tree, which broke the Claude Code VS Code extension with `An error occurred while loading view: claudeVSCodeSidebarSecondary`. `scan_projects` now requires at least one project-marker file (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `requirements.txt`, `pubspec.yaml`, `mix.exs`, `tsconfig.json`, `deno.json`, `.project`, `*.sln`) to consider a directory a workspace.

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
