package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func approxEqual(a, b, eps float64) bool {
	return math.Abs(a-b) < eps
}

// ---------------------------------------------------------------------------
// readAgentMeta
// ---------------------------------------------------------------------------

func TestReadAgentMeta(t *testing.T) {
	tests := []struct {
		name      string
		writeMeta bool
		metaBody  string
		wantOK    bool
		wantAgent agentMeta
	}{
		{
			name:      "present",
			writeMeta: true,
			metaBody:  `{"agentType":"Explore","description":"look around","toolUseId":"toolu_123","spawnDepth":1,"model":"sonnet"}`,
			wantOK:    true,
			wantAgent: agentMeta{AgentType: "Explore", Description: "look around", ToolUseID: "toolu_123", SpawnDepth: 1, Model: "sonnet"},
		},
		{
			name:      "missing",
			writeMeta: false,
			wantOK:    false,
			wantAgent: agentMeta{},
		},
		{
			name:      "malformed",
			writeMeta: true,
			metaBody:  `{"agentType": not-json`,
			wantOK:    false,
			wantAgent: agentMeta{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			jsonlPath := filepath.Join(dir, "agent-x.jsonl")
			if tc.writeMeta {
				metaPath := filepath.Join(dir, "agent-x.meta.json")
				if err := os.WriteFile(metaPath, []byte(tc.metaBody), 0o644); err != nil {
					t.Fatalf("write meta: %v", err)
				}
			}

			got, ok := readAgentMeta(jsonlPath)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && got != tc.wantAgent {
				t.Fatalf("agentMeta = %+v, want %+v", got, tc.wantAgent)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// delegationStats — driven through the real parseFile so the path-based
// isSession logic and the sidecar read are exercised end to end.
// ---------------------------------------------------------------------------

type fixtureUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type fixtureMessage struct {
	Model string       `json:"model"`
	Usage fixtureUsage `json:"usage"`
}

type fixtureLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Message   *fixtureMessage `json:"message,omitempty"`
}

func marshalLine(t *testing.T, l fixtureLine) string {
	t.Helper()
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatalf("marshal line: %v", err)
	}
	return string(b)
}

func writeJSONL(t *testing.T, dir, name string, lines []string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func writeMetaFile(t *testing.T, dir, name string, m agentMeta) {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestDelegationStats(t *testing.T) {
	root := t.TempDir()
	projDir := filepath.Join(root, "demo-project")
	subDir := filepath.Join(projDir, "session1", "subagents")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	now := time.Now().UTC()
	since := now.Add(-7 * 24 * time.Hour)

	userLine := marshalLine(t, fixtureLine{Type: "user", Timestamp: now.Add(-90 * time.Minute).Format(time.RFC3339)})

	// Main thread: $0.45, 110000 tok, 1h ago.
	mainPath := writeJSONL(t, projDir, "session1.jsonl", []string{
		userLine,
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-1 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-sonnet-4-6", Usage: fixtureUsage{InputTokens: 100000, OutputTokens: 10000}}}),
	})

	// agent-a: Explore, routed to sonnet. $0.225, 55000 tok, 2h ago.
	aPath := writeJSONL(t, subDir, "agent-a.jsonl", []string{
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-2 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-sonnet-4-6", Usage: fixtureUsage{InputTokens: 50000, OutputTokens: 5000}}}),
	})
	writeMetaFile(t, subDir, "agent-a.meta.json", agentMeta{AgentType: "Explore", ToolUseID: "toolu_a", SpawnDepth: 1, Model: "sonnet"})

	// agent-b: Explore, sidecar present but empty model -> unrouted. $0.09, 22000 tok, 3h ago.
	// Groups into the same (Explore, sonnet-4-6) row as agent-a.
	bPath := writeJSONL(t, subDir, "agent-b.jsonl", []string{
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-3 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-sonnet-4-6", Usage: fixtureUsage{InputTokens: 20000, OutputTokens: 2000}}}),
	})
	writeMetaFile(t, subDir, "agent-b.meta.json", agentMeta{AgentType: "Explore", ToolUseID: "toolu_b", SpawnDepth: 1, Model: ""})

	// agent-c: no sidecar at all -> agentType "unknown", unrouted. $0.225, 11000 tok, 4h ago.
	cPath := writeJSONL(t, subDir, "agent-c.jsonl", []string{
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-4 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-opus-4-8", Usage: fixtureUsage{InputTokens: 10000, OutputTokens: 1000}}}),
	})

	// agent-d: Explore, routed to haiku, but 10 days old -> outside the 7d window.
	// Must not contribute to subCost/subTokens/totalRuns/unroutedRuns/rows at all.
	dPath := writeJSONL(t, subDir, "agent-d.jsonl", []string{
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-10 * 24 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-haiku-4-5", Usage: fixtureUsage{InputTokens: 999999, OutputTokens: 999999}}}),
	})
	writeMetaFile(t, subDir, "agent-d.meta.json", agentMeta{AgentType: "Explore", ToolUseID: "toolu_d", SpawnDepth: 1, Model: "haiku"})

	// agent-e: Bugfix, routed to sonnet. $0.225, 55000 tok, 5h ago.
	// Same cost as agent-c's row but a different agentType -> tie-break by agentType asc.
	ePath := writeJSONL(t, subDir, "agent-e.jsonl", []string{
		marshalLine(t, fixtureLine{Type: "assistant", Timestamp: now.Add(-5 * time.Hour).Format(time.RFC3339),
			Message: &fixtureMessage{Model: "claude-sonnet-4-6", Usage: fixtureUsage{InputTokens: 50000, OutputTokens: 5000}}}),
	})
	writeMetaFile(t, subDir, "agent-e.meta.json", agentMeta{AgentType: "Bugfix", ToolUseID: "toolu_e", SpawnDepth: 2, Model: "sonnet"})

	var aggs []*fileAgg
	for _, p := range []string{mainPath, aPath, bPath, cPath, dPath, ePath} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		fa := parseFile(p, info)
		aggs = append(aggs, &fa)
	}

	got := delegationStats(aggs, since)

	if !approxEqual(got.mainCost, 0.45, 1e-6) {
		t.Errorf("mainCost = %v, want 0.45", got.mainCost)
	}
	if got.mainTokens != 110000 {
		t.Errorf("mainTokens = %v, want 110000", got.mainTokens)
	}
	if !approxEqual(got.subCost, 0.765, 1e-6) {
		t.Errorf("subCost = %v, want 0.765", got.subCost)
	}
	if got.subTokens != 143000 {
		t.Errorf("subTokens = %v, want 143000", got.subTokens)
	}
	if got.totalRuns != 4 {
		t.Errorf("totalRuns = %v, want 4 (agent-d must be excluded by the 7d window)", got.totalRuns)
	}
	if got.unroutedRuns != 2 {
		t.Errorf("unroutedRuns = %v, want 2 (agent-b empty model + agent-c missing sidecar)", got.unroutedRuns)
	}

	wantRows := []delegationRow{
		{agentType: "Explore", model: "sonnet-4-6", runs: 2, cost: 0.315, tokens: 77000},
		{agentType: "Bugfix", model: "sonnet-4-6", runs: 1, cost: 0.225, tokens: 55000},
		{agentType: "unknown", model: "opus-4-8", runs: 1, cost: 0.225, tokens: 11000},
	}
	if len(got.rows) != len(wantRows) {
		t.Fatalf("rows = %d, want %d: %+v", len(got.rows), len(wantRows), got.rows)
	}
	for i, w := range wantRows {
		r := got.rows[i]
		if r.agentType != w.agentType || r.model != w.model || r.runs != w.runs || r.tokens != w.tokens || !approxEqual(r.cost, w.cost, 1e-6) {
			t.Errorf("rows[%d] = %+v, want %+v", i, r, w)
		}
	}
}

// ---------------------------------------------------------------------------
// renderDelegationReport
// ---------------------------------------------------------------------------

func delegationReportHeader() string {
	return fmt.Sprintf("%-16s %-14s %5s %10s %10s %10s", "agentType", "model", "runs", "cost", "avg/run", "tokens")
}

func delegationReportRow(agentType, model string, runs int, cost, avg, tokens string) string {
	return fmt.Sprintf("%-16s %-14s %5d %10s %10s %10s", agentType, model, runs, cost, avg, tokens)
}

func TestRenderDelegationReport(t *testing.T) {
	t.Run("zero split guards against divide by zero", func(t *testing.T) {
		got := renderDelegationReport(delegation{}, 7)
		want := strings.Join([]string{
			"Delegation report — last 7d",
			"main $0.00 (0%, 0 tok)   sub $0.00 (0%, 0 tok)",
			"unrouted runs: 0 / 0",
			delegationReportHeader(),
		}, "\n")
		if got != want {
			t.Errorf("got:\n%q\nwant:\n%q", got, want)
		}
	})

	t.Run("rows rendered sorted with avg cost", func(t *testing.T) {
		d := delegation{
			mainCost: 6, mainTokens: 60000,
			subCost: 4, subTokens: 40000,
			totalRuns: 3, unroutedRuns: 1,
			rows: []delegationRow{
				{agentType: "Explore", model: "sonnet-4-6", runs: 2, cost: 3, tokens: 30000},
				{agentType: "Bugfix", model: "opus-4-8", runs: 1, cost: 1, tokens: 10000},
			},
		}
		got := renderDelegationReport(d, 30)
		want := strings.Join([]string{
			"Delegation report — last 30d",
			"main $6.00 (60%, 60.0K tok)   sub $4.00 (40%, 40.0K tok)",
			"unrouted runs: 1 / 3",
			delegationReportHeader(),
			delegationReportRow("Explore", "sonnet-4-6", 2, "$3.00", "$1.50", "30.0K"),
			delegationReportRow("Bugfix", "opus-4-8", 1, "$1.00", "$1.00", "10.0K"),
		}, "\n")
		if got != want {
			t.Errorf("got:\n%q\nwant:\n%q", got, want)
		}
	})
}
