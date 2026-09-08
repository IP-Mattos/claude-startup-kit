// Delegation attribution — how much of the spend is the main conversation
// thread versus delegated sub-agents, and which sub-agent roles cost what.
//
// This reads the sidecar Claude Code writes next to each sub-agent
// transcript (<dir>/agent-<id>.meta.json) without changing how cost itself
// is computed (parseFile / priceFor stay the source of truth).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// agentMeta mirrors the sidecar Claude Code writes next to a sub-agent
// transcript: <dir>/agent-<id>.meta.json alongside agent-<id>.jsonl.
type agentMeta struct {
	AgentType   string `json:"agentType"`
	Description string `json:"description"`
	ToolUseID   string `json:"toolUseId"`
	Model       string `json:"model"`
	SpawnDepth  int    `json:"spawnDepth"`
}

// readAgentMeta reads the sidecar next to a sub-agent transcript. It returns
// ok=false when the sidecar is missing or cannot be parsed as JSON.
func readAgentMeta(jsonlPath string) (agentMeta, bool) {
	metaPath := strings.TrimSuffix(jsonlPath, ".jsonl") + ".meta.json"
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return agentMeta{}, false
	}
	var m agentMeta
	if json.Unmarshal(b, &m) != nil {
		return agentMeta{}, false
	}
	return m, true
}

// delegationRow aggregates one (agentType, model) combination over a window.
type delegationRow struct {
	agentType string
	model     string
	runs      int
	cost      float64
	tokens    int
}

// avgCost is the mean cost per run for this row.
func (r delegationRow) avgCost() float64 {
	if r.runs == 0 {
		return 0
	}
	return r.cost / float64(r.runs)
}

// delegation is the main-thread-vs-sub-agent split and per-role breakdown
// for one time window.
type delegation struct {
	mainCost, subCost       float64
	mainTokens, subTokens   int
	rows                    []delegationRow
	totalRuns, unroutedRuns int
}

// delegationStats aggregates parsed transcripts into a delegation report for
// everything active since the given time.
//
// Cost/token totals (mainCost/subCost/mainTokens/subTokens) are summed from
// each fileAgg's per-line events with a timestamp >= since, the same
// convention as the existing today/5h/burn windows in scanner.scan(). A
// sub-agent run counts toward totalRuns/unroutedRuns/rows when its last
// activity (fa.last) falls in the window. Rows are keyed by (agentType,
// shortModel(fa.model)) and sorted by cost descending, then agentType
// ascending.
func delegationStats(aggs []*fileAgg, since time.Time) delegation {
	var d delegation
	type rowKey struct{ agentType, model string }
	rowByKey := map[rowKey]*delegationRow{}
	var order []rowKey

	for _, fa := range aggs {
		var winCost float64
		var winTokens int
		for _, ev := range fa.events {
			if ev.ts.Before(since) {
				continue
			}
			winCost += ev.cost
			winTokens += ev.tokens
		}

		if fa.isSession {
			d.mainCost += winCost
			d.mainTokens += winTokens
			continue
		}

		d.subCost += winCost
		d.subTokens += winTokens

		if fa.last.Before(since) {
			continue
		}
		d.totalRuns++
		if fa.requestedModel == "" {
			d.unroutedRuns++
		}

		key := rowKey{agentType: fa.agentType, model: shortModel(fa.model)}
		r, ok := rowByKey[key]
		if !ok {
			r = &delegationRow{agentType: key.agentType, model: key.model}
			rowByKey[key] = r
			order = append(order, key)
		}
		r.runs++
		r.cost += winCost
		r.tokens += winTokens
	}

	rows := make([]delegationRow, 0, len(order))
	for _, k := range order {
		rows = append(rows, *rowByKey[k])
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].cost != rows[j].cost {
			return rows[i].cost > rows[j].cost
		}
		return rows[i].agentType < rows[j].agentType
	})
	d.rows = rows
	return d
}

// renderDelegationReport formats a delegation split, unrouted count and
// per-role rows as stable plain text. Used directly by --report (all rows)
// and by --stats / the TUI panel (a delegation whose rows have already been
// trimmed to the top N by the caller).
func renderDelegationReport(d delegation, days int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Delegation report — last %dd\n", days)

	total := d.mainCost + d.subCost
	var mainPct, subPct float64
	if total > 0 {
		mainPct = 100 * d.mainCost / total
		subPct = 100 * d.subCost / total
	}
	fmt.Fprintf(&b, "main %s (%.0f%%, %s tok)   sub %s (%.0f%%, %s tok)\n",
		fmtMoney(d.mainCost), mainPct, fmtTokens(d.mainTokens),
		fmtMoney(d.subCost), subPct, fmtTokens(d.subTokens))

	fmt.Fprintf(&b, "unrouted runs: %d / %d\n", d.unroutedRuns, d.totalRuns)

	fmt.Fprintf(&b, "%-16s %-14s %5s %10s %10s %10s\n",
		"agentType", "model", "runs", "cost", "avg/run", "tokens")
	for _, r := range d.rows {
		fmt.Fprintf(&b, "%-16s %-14s %5d %10s %10s %10s\n",
			r.agentType, r.model, r.runs, fmtMoney(r.cost), fmtMoney(r.avgCost()), fmtTokens(r.tokens))
	}

	return strings.TrimRight(b.String(), "\n")
}
