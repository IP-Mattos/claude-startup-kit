<!-- These two blocks are appended to ~/.claude/CLAUDE.md by install.ps1.
     They are wrapped in <!-- user-custom:NAME --> markers so they survive
     `gentle-ai sync` (which only manages blocks under <!-- gentle-ai:... -->).
     The installer is idempotent: it detects each block's marker and skips
     blocks that already exist. -->

<!-- user-custom:design-skill-disambiguation -->
## Design/UI skill disambiguation (user-custom)

When the user asks for UI work, multiple skills could match. Pick ONE primary based on intent — do NOT run all at once, or you get contradictory advice.

| Intent | Primary skill |
| ------ | ------------- |
| Think through requirements / design direction (before any code) | `brainstorming` (ALWAYS first for creative work) |
| Build a new component/page with creative, distinctive aesthetics | `frontend-design` |
| Need design systems, color palettes, font pairings, multi-stack UI guidance | `ui-ux-pro-max` |
| Review/audit existing UI for accessibility or Web Interface Guidelines compliance | `web-design-guidelines` |
| Next.js-specific app-router code (RSC, file conventions, metadata, async APIs) | `next-best-practices` |
| React performance (hooks, memoization, bundle size) | `vercel-react-best-practices` |

Rule: ONE primary per task. Others can be referenced only if the primary explicitly delegates.
<!-- /user-custom:design-skill-disambiguation -->

<!-- user-custom:daily-brief -->
## Daily Brief protocol (user-custom)

When a SessionStart system-reminder contains `[daily-brief:trigger]` followed by a block between `[daily-brief:projects-start]` and `[daily-brief:projects-end]`, this is the first Claude Code session of the calendar day. You MUST do the following BEFORE responding to anything else:

1. Parse the numbered project list from between the markers (format: `N. <path> | last: YYYY-MM-DD (<label>)`).
2. Call `mem_timeline` (or `mem_search` with recent date filters) to gather what was done in the last ~48h across projects. If mem_timeline is unavailable, fall back to `mem_context` + `mem_search` queries per project name.
3. Present a SINGLE welcome message in Rioplatense Spanish (voseo) with this structure:
   - Short greeting ("Buen día, hermano" or similar)
   - **Ayer en resumen**: 1–3 bullets per project that had activity in the last 48h, citing decisions/accomplishments pulled from Engram. Omit projects with no recent memory entries.
   - **Proyectos activos (últimos 14d)**: show the numbered list verbatim from the trigger block, PLUS add one extra numbered option at the end: "N+1. Quedarme acá / empezar algo nuevo".
   - Final line: "¿Cuál abrís hoy?"
4. STOP and wait for the user to respond with a number (or free text).
5. Based on their response:
   - If they pick a valid project number → run `code --new-window "<windows-path>"` via Bash. Use the exact path from the list. Confirm briefly ("Abriendo <project> en una ventana nueva de VS Code.") and STOP.
   - If they pick the last option ("quedarme acá") or give any non-numeric response → skip the launch, acknowledge briefly, and continue handling whatever they said as normal input.
   - If they ignore the menu and just start working → treat it as "quedarme acá" and proceed.

Constraints:
- Do NOT call `mem_timeline` or emit the welcome if there is no `[daily-brief:trigger]` in the current context. The guard runs once per calendar day.
- Do NOT ask the user to confirm before running `code --new-window` — this is already a confirmed action (they picked the number).
- The path in the list may use lowercase drive letter (`c:\...`). Pass it to `code` as-is; Windows accepts both cases.
<!-- /user-custom:daily-brief -->
