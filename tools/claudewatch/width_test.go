package main

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func sampleStats() stats {
	st := stats{
		totalCost: 36391.93, totalTokens: 13470000000,
		sessions: 36, msgs: 51622,
		todayCost: 875.23, burnHr: 205.70,
		h5Cost: 265.83, h5Tokens: 41840000, tokPerMin: 548959,
		byModel: []modelRow{
			{"opus-4-8", 27104.32, 9640000000},
			{"opus-4-7", 6874.29, 2710000000},
			{"sonnet-4-6", 182.58, 324000000},
		},
		recent: []sessionRow{
			{project: "polymarket-bot", model: "claude-opus-4-8", tokens: 7950000, cost: 38.79, last: time.Now()},
			{project: "claudewatch", model: "claude-opus-4-8", tokens: 3290000, cost: 22.23, last: time.Now()},
		},
	}
	for i := range st.hourly {
		st.hourly[i] = float64((i*7)%13) + 1
	}
	st.actModel = "claude-opus-4-8[1m]"
	st.actCtx = 152000
	st.actWindow = 1000000
	st.actCtxPct = 15.2
	st.actCost = 22.23
	st.actTokens = 3290000
	st.actProject = "claudewatch"
	st.byProject = []projectRow{
		{"polymarket-bot", 1204.50, 0},
		{"DemonTwo", 890.10, 0},
		{"Polymarket", 612.30, 0},
	}
	st.delegation7d = delegation{
		mainCost: 2163.09, mainTokens: 492380000,
		subCost: 830.10, subTokens: 224200000,
		totalRuns: 23, unroutedRuns: 16,
		rows: []delegationRow{
			// Long agentType/model combos on purpose — stresses the panel's
			// dynamic truncation at narrow widths.
			{agentType: "general-purpose", model: "fable-5-1", runs: 14, cost: 792.69, tokens: 164280000},
			{agentType: "general-purpose", model: "sonnet-5", runs: 4, cost: 23.94, tokens: 50320000},
			{agentType: "claude-code-guide", model: "sonnet-5", runs: 2, cost: 3.65, tokens: 4310000},
			{agentType: "Explore", model: "opus-5", runs: 1, cost: 7.96, tokens: 1840000},
			{agentType: "Explore", model: "sonnet-5", runs: 1, cost: 1.04, tokens: 981500},
		},
	}
	return st
}

// The bug we fixed: in a narrow pane the view forced a wide width and overflowed.
// Assert that no rendered line is wider than the terminal width at any size.
func TestViewFitsWidth(t *testing.T) {
	st := sampleStats()
	for _, w := range []int{44, 56, 80, 120, 200} {
		m := model{st: st, width: w, height: 40}
		out := m.View()
		for i, line := range strings.Split(out, "\n") {
			if lw := lipgloss.Width(line); lw > w {
				t.Errorf("width=%d: line %d overflows (%d cols > %d):\n%q", w, i, lw, w, line)
			}
		}
	}
}
