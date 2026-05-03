# Audit Report — Pass 3 (5 parallel agents)

Date: 2026-05-02
Branch: feat/tauri-rewrite → promoted to `desktopapp`
Scope: `app/` (Tauri 2 + React 19 + Vite). Shell kit moved to `legacy/` in this same restructure.

This report consolidates findings from five focused agents (security, performance, a11y/UX, themes/CSS, code/architecture). Items already fixed in Pass 1/Pass 2 are NOT relisted here; this is the next backlog.

---

## Security

### CRIT
- **`src-tauri/src/lib.rs:759` — `git_last_commit` `-C` flag injection**: `git -C path` accepts user-controlled path without validation. If `path` starts with `-` it becomes a flag; UNC paths not rejected. Fix: call `validate_open_path(path)?` or use `Command::current_dir(path)` instead of `-C`.
- **`src-tauri/src/lib.rs:690–701` — `engram_project_goal` no path validation**: `path` flows into `Path::new(path).file_name()` without canonicalization. Malicious project name could inject CLI args. Fix: `validate_open_path` + leaf allowlist (alphanumeric / `-` / `_`).
- **`src-tauri/src/lib.rs:526–536` — `run_audit` script integrity**: hardcoded path `~/.claude/scripts/claude-audit.ps1`; if `.claude/scripts/` is world-writable, the script can be replaced. Exit codes not checked against known values. Fix: SHA256 hash check at runtime + accept only specific exit codes.

### WARN
- **`src-tauri/src/lib.rs:419–431` — `github_review_queue` unbounded `limit`**: clamp to `min(500).max(1)`.
- **`src-tauri/src/lib.rs:601, 690` — `Command::new("git"/"engram")` PATH shadowing**: on Windows, attacker-controlled directory in `PATH` can shadow these binaries. Use absolute paths or signature check.
- **`src-tauri/src/lib.rs:684–707` — `resolve_engram_project` case-insensitive collision**: two projects differing only in case can match the wrong one. Prefer exact-case primary, fuzzy fallback only if no exact match. Allowlist project-name chars.
- **`src-tauri/src/lib.rs:668–681` — `first_cwd_in_jsonls` no validation of `cwd`**: malicious JSONL writes inject arbitrary paths. Validate `cwd` is absolute and canonicalizable before returning.
- **`src-tauri/tauri.conf.json:27` — CSP missing directives**: add `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.

### SUG
- **`src-tauri/src/lib.rs:829–858` — `validate_open_path` symlink TOCTOU**: small race between canonicalize and spawn.
- **`src-tauri/capabilities/default.json` — no scoped FS permissions**: explicitly scope future `fs:*` permissions to `~/.claude/**`.

---

## Performance

### CRIT
- **`src/v3/AppV3.css:8–36` — 28 themes eagerly loaded via `@import`**: ~40 KB of dead CSS shipped on every boot. Vite cannot tree-shake `@import`. Fix: drop the `@import` chain, dynamic-import only the active theme on theme-change. Configure `manualChunks` in `vite.config.ts` so each theme becomes a separate lazy chunk.

### WARN
- **`src/v3/views.tsx:420–426` — triple filter pass for audit counts**: 4× walks per render. Replace with a single `findings.reduce(...)`.
- **`src/v3/AppV3.tsx:663–676` — inline `onOpen` arrow in `recentProjects.map`**: new closure each render forces `RecentProjectCard` remount. Wrap card in `React.memo`, pass stable handler via `useCallback`.
- **`src/v3/views.tsx:665–696` — Cleanup `catBytes` recomputed inline on every render**: move into `useMemo` keyed on `items`.

### SUG
- **`src/v3/views.tsx:677` — `list.slice(0, 10)` in render body**: memoize the truncated list.

---

## Accessibility & UX

### CRIT
- **`src/v3/themes/y2k.css:217–226` — chip contrast failures**: `chip-info.active` 2.5:1, `chip-warn.active` 4.3:1 — both fail WCAG AA.
- **`src/v3/views.tsx:506–531` — FilterChip no async feedback**: re-filter happens silently; users may double-click. Disable chip while computing.
- **`src/v3/AppV3.tsx:474–482` — "Open Command Center" button has no handler**: dead button — implement or remove.

### WARN
- **`src/v3/views.tsx:477, 657, 322, 161` — `.v3-error` divs need `role="alert"` / `aria-live`**.
- **`src/v3/views.tsx:756–806` — companion form file input lacks proper `<label htmlFor>` association**.
- **`src/v3/views.tsx:645–655` — `.v3-success` lacks `aria-live="polite"`**.
- **`src/v3/AppV3.tsx:597–612` — Palette + Settings icon-only buttons**: only have `title` attr, no visible tooltip on focus.
- **`src/v3/AppV3.css:1271` — chip-warn.active light theme contrast 4.6:1**: AA pass with no buffer; bump to AAA.

### SUG
- **`src/v3/AppV3.tsx:811–821` — Ctrl+1..7 may collide** with browser tab shortcuts; consider Alt+1..7.
- **`src/v3/AppV3.css:1652–1659` — `prefers-reduced-motion`** could also force `scroll-behavior: auto`.
- Loading states use static text — consider skeleton loaders + `aria-busy` for >1s waits.
- File input validation error not announced (`role="alert"`).
- No `:disabled` button styling defined.
- "…and N more" in cleanup is a dead end — add expand/paginate.
- QuickActions icon-only buttons need keyboard-visible tooltips.

---

## Themes / CSS

### CRIT
- **5 themes missing scrollbar-thumb override** (dracula, kawaii, moon-zine, pulse, y2k): inherit light grey on dark UI.
- **`.v3-link` hardcoded to `#2563EB`** in base + 13 themes that never override → invisible links on dark themes (akira, crimson-arch, dark, grid, kill-switch, light, lilac-os, nord, petrick, pixel-kit, solarized-dark). Fix: `.v3-link { color: var(--v3-link, #2563EB) }` + per-theme override.
- **lilac-os, nord — `.v3-side-link.active` missing left accent bar**: `inset 2px 0 0 <accent>` for consistency with dark/dracula/gruvbox/gameboy.

### WARN
- Focus-visible orange outline on dark themes (nord, petrick, retro-os) is hard to see — themes need their own focus-visible override.
- Scrollbar `border-radius: 4px` redeclared in nearly every theme — extract to `--v3-scrollbar-radius` token.
- `tokyo.css` `.v3-row:hover` restricted to `[role="button"]` — should apply to all rows.

### SUG
- `.v3-pr-pill-review` has no theme-neutral fallback in base; pills disappear if a theme forgets to override.
- One magic number left: `.v3-pct-pill { padding: 2px 8px }`.

---

## Code Quality & Architecture

### CRIT
- **`src/v3/AppV3.tsx:872–880` — silent error swallowing**: every `invoke().catch(() => [])` hides backend failures behind empty states. Surface errors with retry UI.
- **`src/types.ts:16` ↔ `src-tauri/src/lib.rs:513–514` — `AuditFinding.level` type drift**: TS expects `OK | INFO | WARN | CRIT` but Rust returns raw `String`. Validate at deserialize boundary; use exhaustive switch.

### WARN
- **`src/v3/AppV3.tsx` is 1055 lines** mixing data fetch, keyboard, theme, window control, companion persistence + 16 inline subcomponents. Split into hooks (`useAppData`, `useKeyboardShortcuts`, `useThemeManager`, `useCompanion`) + `components/` files.
- Views (`OverviewView`, `TopbarV3`, `SidebarV3`, `StatusBarV3`) defined inline — promote to dedicated files.
- Prop drilling through OverviewView (10 props); missing `React.memo` on view components.
- Per-project enrichment failures swallowed silently (`enrichProjects.ts:34–43`) — show partial-load warning.
- Rust `dir_size` recursive without memoization; consider `walkdir` + skip-list (`.git`, `node_modules`).
- `V3_THEME_ORDER` (AppV3.tsx) and `V3_THEMES` (views.tsx) are duplicated arrays — extract to `lib/themes.ts`.

### SUG
- Rust errors are all `Result<T, String>` — define a `RustError` enum for structured codes.
- AuditView/CleanupView render entire lists — virtualize at 1000+ items.
- Stabilize `handleCycleTheme` with `useCallback`.
- `tsconfig.json` missing `noImplicitThis`, `exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`.
- No lint/format pipeline (`eslint`, `prettier`); no precommit hooks; no tests.
- Companion state persistence inline in AppV3 — extract to `useCompanion`.

---

## Recommended next slice (high-value, low-risk)

1. Theme `@import` chain → dynamic import (perf CRIT).
2. AuditFinding level discriminated union + boundary validator (type CRIT).
3. Surface fetch errors with retry banner (UX CRIT).
4. Add `role="alert"` / `aria-live` to error and success divs.
5. Fix the 13 themes' missing `.v3-link` color + 5 missing scrollbar-thumb overrides.
6. Implement or remove "Open Command Center" button.
7. Extract `useAppData` and `useKeyboardShortcuts` hooks from AppV3.

The backlog beyond that is real but compounding — split AppV3 first, then attack security + tests.
