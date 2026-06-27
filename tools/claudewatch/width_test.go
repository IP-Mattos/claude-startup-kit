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
