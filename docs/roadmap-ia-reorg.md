# Roadmap — App Information Architecture Reorg

> Goal: cut the app from **13 tabs** to a small set of operational sections,
> replace passive "sections you have to remember to open" with **signal that
> comes to you**, and kill information that isn't actionable.
>
> Status: PLAN. No code yet. Phases are ordered by value/risk.

## The problem today

13 tabs across two tracks:

- **Sidebar** — Workspace (Overview, Projects, PRs) · Insights (Conversations, Tokens, Standup) · Work (Todos, Audit, Cleanup)
- **Topbar** — Claude, Sync, Companion, Settings

Symptoms (user-reported):
- Things you don't use take prime real estate (Todos, Standup).
- Things you *would* use are buried with no way to surface them (Cleanup is at the bottom, never in view, no reminder).
- "Sections" exist for things that should be inline info (Tokens) or background behavior (Audit).
- The Overview reports counts, not signal ("Audit: 15 findings" — but only warnings/dangerous matter; INFO is noise).
- Some tabs never produced anything (PRs).

## Guiding principles

1. **A tab earns its place only if you open it on purpose, repeatedly.** Everything else is either inline info, a background job that notifies, or deleted.
2. **Automatic work announces itself.** Audit and cleanup run on open and surface *actionable* results; the detail view is a destination you reach *from* the alert, not a tab you must remember.
3. **Signal, not counts.** Show what needs a decision (warnings, reclaimable space, available updates). Never show INFO-level state as if it were news.
4. **Settings is where low-frequency config lives** — grouped, not a flat dump.

## Target structure

### Sidebar (operational — what you touch often)

| Tab | What it is | Change |
|-----|-----------|--------|
| **Overview** | Actionable signal feed (audit warnings, reclaimable space, updates) + recent projects + an embedded **Tokens** panel with a `day / week / month / origin` filter | Rebuilt |
| **Projects** | List + open + **clone from GitHub** (absorbs the only real use of Sync) | Extended |
| **Claude** | Skills (paginated) + **Suggested skills** (moved here) + MCP servers + gentle-ai component status | Extended |
| **Audit** | Detail view of the latest audit run | Kept, but demoted: runs on open, notifies; you land here from the alert |
| **Conversations** | JSONL full-text search | Kept, **redesigned** (see Phase 6) |

### Meta (Settings, grouped)

- **General** — language, theme, startup behavior
- **Shortcuts** — keybindings
- **Gentle AI** — stack updates (gentle-ai / engram / gga)
- **Claude Startup Kit** — app updates, **Cleanup**, maintenance
- **Companion** — name/image (moved out of its own tab)

### Cross-cutting: the "on open" signal system (NEW)

The piece that fixes Audit + Cleanup at once. On app launch, in the background:
- run the audit → if any **warning+** finding, raise an alert
- check reclaimable space → if over a threshold, raise a **cleanup reminder**
- check stack/app updates → if any, raise an update alert

Alerts render on the Overview as a short, dismissible list. Click → go to the
relevant section. Nothing INFO-level ever raises an alert.

### Deleted

- **Todos** — unused. Remove tab, IPCs (`list/add/toggle/delete/update_todo`), storage.
- **Standup** — no longer meaningful. Remove tab + `daily_standup` IPC.
- **Sync (tab)** — unused except cloning GitHub projects; that one function moves into Projects. Remove the tab and the engram-sync push/pull/status surface.
- **gentle-ai "Sincronizar"** — unused, error-prone, ill-posed. Remove from the Claude tab.

### Open decision

- **PRs** — not broken; it queries `gh search prs --review-requested=@me`, which is empty for a solo dev nobody requests review from. Two options:
  - **(A) Repurpose**: show *your own* open PRs (`--author=@me`) instead. Useful if you open PRs.
  - **(B) Remove**: drop the tab entirely.
  - *Recommendation*: (B) remove unless you actually open PRs regularly; it's dead weight today.

## Phases (ordered by value ÷ risk)

**Phase 0 — Delete the dead weight.** Remove Todos and Standup (tabs + IPCs + nav). Lowest risk, immediate declutter. Frees Ctrl+number slots.

**Phase 1 — Restructure Settings.** Introduce the 5 groups (General / Shortcuts / Gentle AI / Claude Startup Kit / Companion). Move Companion out of its tab into Settings. Pure move + regroup; no behavior change.

**Phase 2 — Rebuild Overview.** Replace count tiles with an actionable signal feed. Embed Tokens as a panel with the `day/week/month/origin` filter. Remove the Tokens tab.

**Phase 3 — "On open" signal system.** Background audit-on-launch + cleanup-threshold check + update check → alerts on Overview. Demote Audit (keep detail view, reach it from alert). Move Cleanup into Settings → Claude Startup Kit, surfaced by the reminder.

**Phase 4 — Claude hub.** Move Suggested Skills into the Claude tab. Paginate the skills list. Remove the gentle-ai "Sincronizar" action.

**Phase 5 — Projects absorbs cloning.** Bring "clone from GitHub" into Projects. Remove the Sync tab and its engram-sync surface.

**Phase 6 — Conversations redesign + PRs decision.** Rethink Conversations structure (search-first, grouped results). Resolve the PRs open decision (repurpose vs remove).

## End state

From 13 tabs → **5 sidebar** (Overview, Projects, Claude, Audit, Conversations)
+ **Settings** (5 groups). Audit and Cleanup stop being tabs-you-forget and
become **alerts that find you**. Tokens becomes inline info. Overview shows
decisions to make, not counts to ignore.
