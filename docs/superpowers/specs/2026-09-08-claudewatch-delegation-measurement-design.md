# claudewatch delegation measurement

Date: 2026-09-08
Status: approved

## Context

This is phase 1 of a model-routing system for Claude Code. The routing
decisions (which sub-agent role runs on which model and effort) will be
driven by measured cost, not by guesses. Today claudewatch reports cost per
model and per session but cannot say how much of the spend is the main
conversation thread versus delegated sub-agents, nor which sub-agent roles
cost what.

## What is on disk

Claude Code (2.1.263) stores each sub-agent run outside the session file:

```
<project>/<sessionId>.jsonl                      main thread
<project>/<sessionId>/subagents/agent-<id>.jsonl sub-agent turns
<project>/<sessionId>/subagents/agent-<id>.meta.json
```

The sidecar carries `agentType`, `description`, `toolUseId`, `spawnDepth`
and `model` (the model requested by the orchestrator, empty when it passed
none). Sub-agent assistant lines carry `message.model` and `message.usage`
with the same shape as main-thread lines, so the existing cost formula
applies unchanged.

claudewatch already walks the `subagents/` files and folds their cost into
the totals. It distinguishes them only by path (`isSession`) and never reads
the sidecar.

## Decision

Add delegation attribution to claudewatch without changing how cost is
computed:

1. For every sub-agent transcript, read the sibling `.meta.json`. Missing or
   malformed sidecar means `agentType = "unknown"` and an empty requested
   model.
2. Aggregate, for a time window:
   - main-thread cost and tokens versus sub-agent cost and tokens, with
     percentages;
   - rows keyed by `agentType` and the actual model seen in the transcript:
     runs (one transcript = one run), cost, tokens, average cost per run,
     sorted by cost descending;
   - `unroutedRuns`: sub-agent runs whose sidecar has an empty requested
     model. This measures whether the orchestrator follows the "every Agent
     call carries `model`" rule and decides whether an enforcement hook is
     needed later.
3. Outputs:
   - a `DELEGATION (7d)` panel in the TUI after the SPEND panel: split line,
     unrouted line, top rows;
   - the same summary appended to `--stats`;
   - a new one-shot flag `--report [days]` (default 7) that prints the full
     table and exits. This is the input for the periodic routing review.

Window filtering uses the per-line event timestamps already collected in
`fileAgg.events`, consistent with the existing today/5h/burn calculations. A
run counts in the window when its last activity falls inside it.

## Code shape (tools/claudewatch/main.go)

- `agentMeta` struct + `readAgentMeta(jsonlPath string) (agentMeta, bool)`.
- `fileAgg` gains `agentType`, `requestedModel`, `spawnDepth`; `parseFile`
  fills them for sub-agent files.
- Pure aggregation `delegationStats(aggs []*fileAgg, since time.Time) delegation`
  returning the split, the rows and the unrouted count.
- Pure formatting `renderDelegationReport(d delegation, days int) string`
  shared by `--report` and `--stats`.
- `stats` gains `delegation7d`; `scan()` fills it; `View()` renders the panel
  with the existing width helpers.

## Testing

Strict TDD, table-driven, in the existing package:

- `readAgentMeta`: present, missing, malformed sidecar.
- `delegationStats`: main/sub split, grouping by type and model, unrouted
  counting, window filtering, sort order.
- `renderDelegationReport`: stable text output for a small fixture.

Fixtures are written to `t.TempDir()` as minimal JSONL and meta files and
parsed through the real `parseFile` path.

## Out of scope

- Any routing change (rules files, custom agents, gentle-ai presets). Those
  wait for measured data.
- Rework detection (a task delegated twice). Possible later heuristic.
- Reading the parent transcript's `tool_use` records; the sidecar is enough.
