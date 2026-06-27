// claudewatch — a futuristic TUI dashboard for Claude Code usage.
//
// It reads the local Claude Code session transcripts under
// ~/.claude/projects/**/*.jsonl, aggregates token usage per message, and
// ESTIMATES cost from a per-model pricing table (Claude Code does not store
// cost on disk — only token counts — so cost is always derived here).
//
// Run it bare for the live TUI, or with --stats to print a one-shot text
// summary (no TTY needed; handy for piping into a statusline).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---------------------------------------------------------------------------
// Pricing — USD per 1,000,000 tokens. Edit here if Anthropic changes rates.
// ---------------------------------------------------------------------------

type price struct {
	in, out, cacheWrite5m, cacheWrite1h, cacheRead float64
}

func priceFor(model string) price {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return price{in: 15, out: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5}
	case strings.Contains(m, "sonnet"):
		return price{in: 3, out: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.30}
	case strings.Contains(m, "haiku"):
		return price{in: 1, out: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.10}
	default: // unknown model — assume Opus-tier so we never under-report
		return price{in: 15, out: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5}
	}
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

type rawLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
	GitBranch string `json:"gitBranch"`
	Message   *struct {
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreation            *struct {
				Ephemeral1h int `json:"ephemeral_1h_input_tokens"`
				Ephemeral5m int `json:"ephemeral_5m_input_tokens"`
			} `json:"cache_creation"`
			ServerToolUse *struct {
				WebSearch int `json:"web_search_requests"`
				WebFetch  int `json:"web_fetch_requests"`
			} `json:"server_tool_use"`
		} `json:"usage"`
	} `json:"message"`
}

type event struct {
	ts     time.Time
	cost   float64
	tokens int
	model  string
}

type fileAgg struct {
	mtime                              time.Time
	size                               int64
	cost                               float64
	tokens                             int
	input, output, cacheWrite, cacheRead int
	webSearch, webFetch                int
	model                              string // last model seen
	project                            string // basename of last cwd
	branch                             string
	last                               time.Time
	msgs                               int
	events                             []event
	isSession                          bool // a top-level session file (not a subagent)
}

func parseFile(path string, info fs.FileInfo) fileAgg {
	slash := filepath.ToSlash(path)
	fa := fileAgg{
		mtime:     info.ModTime(),
		size:      info.Size(),
		isSession: !strings.Contains(slash, "/subagents/"),
	}
	f, err := os.Open(path)
	if err != nil {
		return fa
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024) // transcript lines can be huge
	for sc.Scan() {
		var r rawLine
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			continue
		}
		if r.Cwd != "" {
			fa.project = filepath.Base(r.Cwd)
		}
		if r.GitBranch != "" {
			fa.branch = r.GitBranch
		}
		if r.Message == nil || r.Message.Usage == nil {
			continue
		}
		u := r.Message.Usage
		if r.Message.Model != "" {
			fa.model = r.Message.Model
		}
		p := priceFor(r.Message.Model)

		cw5, cw1 := 0, 0
		if u.CacheCreation != nil {
			cw5, cw1 = u.CacheCreation.Ephemeral5m, u.CacheCreation.Ephemeral1h
		}
		if cw5+cw1 == 0 { // no breakdown — treat all cache writes as 5m
			cw5 = u.CacheCreationInputTokens
		}
		cost := float64(u.InputTokens)*p.in/1e6 +
			float64(u.OutputTokens)*p.out/1e6 +
			float64(cw5)*p.cacheWrite5m/1e6 +
			float64(cw1)*p.cacheWrite1h/1e6 +
			float64(u.CacheReadInputTokens)*p.cacheRead/1e6
		toks := u.InputTokens + u.OutputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens

		fa.cost += cost
		fa.tokens += toks
		fa.input += u.InputTokens
		fa.output += u.OutputTokens
		fa.cacheWrite += u.CacheCreationInputTokens
		fa.cacheRead += u.CacheReadInputTokens
		fa.msgs++
		if u.ServerToolUse != nil {
			fa.webSearch += u.ServerToolUse.WebSearch
			fa.webFetch += u.ServerToolUse.WebFetch
		}

		ts, _ := time.Parse(time.RFC3339, r.Timestamp)
		if ts.After(fa.last) {
			fa.last = ts
		}
		fa.events = append(fa.events, event{ts: ts, cost: cost, tokens: toks, model: r.Message.Model})
	}
	return fa
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type modelRow struct {
	model  string
	cost   float64
	tokens int
}

type sessionRow struct {
	project string
	model   string
	tokens  int
	cost    float64
	last    time.Time
	branch  string
}

type stats struct {
	totalCost                            float64
	totalTokens                          int
	totalInput, totalOutput              int
	totalCacheWrite, totalCacheRead      int
	sessions, msgs                       int
	webSearch, webFetch                  int
	todayCost                            float64
	todayTokens                          int
	h5Cost                               float64
	h5Tokens                             int
	burnHr                               float64 // USD spent in the last hour
	burnTok                              int
	tokPerMin                            float64
	hourly                               [24]float64 // cost per hour, last 24h
	byModel                              []modelRow
	recent                               []sessionRow
}

type scanner struct {
	root  string
	cache map[string]fileAgg
}

func (s *scanner) scan() stats {
	newCache := make(map[string]fileAgg)
	filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".jsonl") || strings.HasSuffix(path, "journal.jsonl") {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return nil
		}
		if old, ok := s.cache[path]; ok && old.mtime.Equal(info.ModTime()) && old.size == info.Size() {
			newCache[path] = old // unchanged — reuse parsed aggregate
		} else {
			newCache[path] = parseFile(path, info)
		}
		return nil
	})
	s.cache = newCache

	var st stats
	var events []event
	for _, fa := range newCache {
		st.totalCost += fa.cost
		st.totalTokens += fa.tokens
		st.totalInput += fa.input
		st.totalOutput += fa.output
		st.totalCacheWrite += fa.cacheWrite
		st.totalCacheRead += fa.cacheRead
		st.msgs += fa.msgs
		st.webSearch += fa.webSearch
		st.webFetch += fa.webFetch
		events = append(events, fa.events...)
		if fa.isSession && fa.msgs > 0 {
			st.sessions++
			st.recent = append(st.recent, sessionRow{
				project: fa.project, model: fa.model, tokens: fa.tokens,
				cost: fa.cost, last: fa.last, branch: fa.branch,
			})
		}
	}

	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	w5 := now.Add(-5 * time.Hour)
	w1 := now.Add(-time.Hour)
	bm := map[string]*modelRow{}
	for _, ev := range events {
		key := shortModel(ev.model)
		r := bm[key]
		if r == nil {
			r = &modelRow{model: key}
			bm[key] = r
		}
		r.cost += ev.cost
		r.tokens += ev.tokens
		if ev.ts.IsZero() {
			continue
		}
		if ev.ts.After(today) {
			st.todayCost += ev.cost
			st.todayTokens += ev.tokens
		}
		if ev.ts.After(w5) {
			st.h5Cost += ev.cost
			st.h5Tokens += ev.tokens
		}
		if ev.ts.After(w1) {
			st.burnHr += ev.cost
			st.burnTok += ev.tokens
		}
		if d := now.Sub(ev.ts); d >= 0 && d < 24*time.Hour {
			if idx := 23 - int(d.Hours()); idx >= 0 && idx < 24 {
				st.hourly[idx] += ev.cost
			}
		}
	}
	for _, r := range bm {
		st.byModel = append(st.byModel, *r)
	}
	sort.Slice(st.byModel, func(i, j int) bool { return st.byModel[i].cost > st.byModel[j].cost })
	sort.Slice(st.recent, func(i, j int) bool { return st.recent[i].last.After(st.recent[j].last) })
	if len(st.recent) > 8 {
		st.recent = st.recent[:8]
	}
	st.tokPerMin = float64(st.burnTok) / 60.0
	return st
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

func fmtTokens(n int) string {
	f := float64(n)
	switch {
	case f >= 1e9:
		return fmt.Sprintf("%.2fB", f/1e9)
	case f >= 1e6:
		return fmt.Sprintf("%.2fM", f/1e6)
	case f >= 1e3:
		return fmt.Sprintf("%.1fK", f/1e3)
	default:
		return fmt.Sprintf("%d", n)
	}
}

func fmtMoney(v float64) string {
	s := fmt.Sprintf("%.2f", v)
	parts := strings.SplitN(s, ".", 2)
	intp, frac := parts[0], parts[1]
	neg := strings.HasPrefix(intp, "-")
	if neg {
		intp = intp[1:]
	}
	var b []byte
	for i := 0; i < len(intp); i++ {
		if i > 0 && (len(intp)-i)%3 == 0 {
			b = append(b, ',')
		}
		b = append(b, intp[i])
	}
	res := "$" + string(b) + "." + frac
	if neg {
		res = "-" + res
	}
	return res
}

func shortModel(m string) string {
	m = strings.TrimPrefix(strings.ToLower(m), "claude-")
	if i := strings.Index(m, "["); i > 0 {
		m = m[:i]
	}
	for _, suf := range []string{"-20251001", "-latest"} {
		m = strings.TrimSuffix(m, suf)
	}
	if m == "" {
		return "unknown"
	}
	return m
}

func ago(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func padRight(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		if n > 1 {
			return string(r[:n-1]) + "…"
		}
		return string(r[:n])
	}
	return s + strings.Repeat(" ", n-len(r))
}

func barChart(frac float64, width int) string {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	fill := int(frac*float64(width) + 0.5)
	return strings.Repeat("█", fill) + strings.Repeat("░", width-fill)
}

func sparkline(vals []float64) string {
	blocks := []rune("▁▂▃▄▅▆▇█")
	max := 0.0
	for _, v := range vals {
		if v > max {
			max = v
		}
	}
	var b strings.Builder
	for _, v := range vals {
		if max == 0 {
			b.WriteRune(' ')
			continue
		}
		idx := int(v / max * float64(len(blocks)-1) + 0.5)
		b.WriteRune(blocks[idx])
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// A theme is a palette. Names mirror the Windows Terminal color schemes so the
// dashboard matches the pane it runs in.
type theme struct {
	name                                string
	cyan, mag, green, yellow, dim, text lipgloss.Color
}

var themes = []theme{
	// "gentleman" mirrors Claude Code's custom Gentleman theme
	// (~/.claude/themes/gentleman.json): warm gold #DCA561 accent over a
	// Kanagawa-ish base, so the dashboard matches Claude. Default.
	{"gentleman", "#7AA89F", "#957FB8", "#76946A", "#DCA561", "#727169", "#DCD7BA"},
	// "auto" uses the terminal's ANSI palette, so claudewatch follows whatever
	// Windows Terminal color scheme is active (matches Claude on dark-ansi).
	{"auto", "6", "5", "2", "3", "8", "7"},
	{"neon", "#22D3EE", "#E879F9", "#34D399", "#FBBF24", "#64748B", "#E2E8F0"},
	{"andromeda", "#2EE6D6", "#C74DED", "#05BC79", "#E5E512", "#8A8F98", "#E5E5E5"},
	{"dracula", "#8BE9FD", "#FF79C6", "#50FA7B", "#F1FA8C", "#6272A4", "#F8F8F2"},
	{"kanagawa", "#7AA89F", "#957FB8", "#98BB6C", "#E6C384", "#727169", "#DCD7BA"},
}

// Active palette — reassigned by applyTheme so existing call sites (which read
// these package vars) keep working without threading a theme through everything.
var (
	cCyan, cMag, cGreen, cYellow, cDim, cText lipgloss.Color
	activeTheme                               int
)

func init() { applyTheme(0) }

func applyTheme(i int) {
	if i < 0 || i >= len(themes) {
		i = 0
	}
	activeTheme = i
	t := themes[i]
	cCyan, cMag, cGreen, cYellow, cDim, cText = t.cyan, t.mag, t.green, t.yellow, t.dim, t.text
}

func themeByName(name string) int {
	for i, t := range themes {
		if strings.EqualFold(t.name, name) {
			return i
		}
	}
	return -1
}

func themeNames() string {
	names := make([]string, len(themes))
	for i, t := range themes {
		names[i] = t.name
	}
	return strings.Join(names, ", ")
}

func themeFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claudewatch-theme")
}

func loadThemePref() {
	if b, err := os.ReadFile(themeFile()); err == nil {
		if i := themeByName(strings.TrimSpace(string(b))); i >= 0 {
			applyTheme(i)
		}
	}
}

func saveThemePref() {
	if f := themeFile(); f != "" {
		_ = os.WriteFile(f, []byte(themes[activeTheme].name), 0o644)
	}
}

func card(label, value string, accent lipgloss.Color, w int) string {
	lab := lipgloss.NewStyle().Foreground(cDim).Render(label)
	val := lipgloss.NewStyle().Foreground(accent).Bold(true).Render(value)
	body := lipgloss.JoinVertical(lipgloss.Left, lab, val)
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(accent).
		Padding(0, 1).Width(max(1, w-2)).Render(body) // -2: border adds a column each side
}

func panel(title, body string, accent lipgloss.Color, w int) string {
	t := lipgloss.NewStyle().Foreground(accent).Bold(true).Render(title)
	inner := lipgloss.JoinVertical(lipgloss.Left, t, body)
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(cDim).
		Padding(0, 1).Width(max(1, w-2)).Render(inner) // -2: border adds a column each side
}

// ---------------------------------------------------------------------------
// Bubble Tea program
// ---------------------------------------------------------------------------

type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

type model struct {
	sc            *scanner
	st            stats
	width, height int
}

func (m model) Init() tea.Cmd { return tick() }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		case "r":
			m.st = m.sc.scan()
		case "t":
			applyTheme((activeTheme + 1) % len(themes))
			saveThemePref()
		}
	case tickMsg:
		m.st = m.sc.scan()
		return m, tick()
	}
	return m, nil
}

func clampi(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// arrange lays items into rows of at most perRow, separated by a 1-col gap.
func arrange(items []string, perRow int) string {
	if perRow < 1 {
		perRow = 1
	}
	var rows []string
	for i := 0; i < len(items); i += perRow {
		end := clampi(i+perRow, 0, len(items))
		seg := make([]string, 0, perRow*2)
		for j := i; j < end; j++ {
			if j > i {
				seg = append(seg, " ")
			}
			seg = append(seg, items[j])
		}
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, seg...))
	}
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}

func (m model) View() string {
	st := m.st
	now := time.Now()

	w := m.width
	if w <= 0 {
		w = 80 // before the first WindowSizeMsg
	}
	inner := w - 2
	if inner < 26 {
		inner = 26
	}

	dim := func(s string) string { return lipgloss.NewStyle().Foreground(cDim).Render(s) }
	txt := func(s string) string { return lipgloss.NewStyle().Foreground(cText).Render(s) }

	// ---- Header (collapses to two lines when narrow) ----
	title := lipgloss.NewStyle().Foreground(cCyan).Bold(true).Render("◢◤ CLAUDE·WATCH ◥◣")
	var header string
	if inner >= 64 {
		clock := lipgloss.NewStyle().Foreground(cMag).Render(now.Format("Mon 02 Jan · 15:04:05"))
		sp := inner - lipgloss.Width(title) - lipgloss.Width(clock)
		if sp < 1 {
			sp = 1
		}
		mid := lipgloss.NewStyle().Foreground(cDim).Width(sp).Align(lipgloss.Center).
			Render(fmt.Sprintf("%d sessions · %d msgs · live", st.sessions, st.msgs))
		header = lipgloss.JoinHorizontal(lipgloss.Top, title, mid, clock)
	} else {
		header = lipgloss.JoinVertical(lipgloss.Left, title,
			dim(fmt.Sprintf("%d sess · %d msgs · %s", st.sessions, st.msgs, now.Format("15:04:05"))))
	}

	// ---- Stat cards (responsive grid: 4→2→1 per row) ----
	perRow := clampi(inner/18, 1, 4)
	cardW := (inner - (perRow - 1)) / perRow
	cards := arrange([]string{
		card("TOTAL SPEND", fmtMoney(st.totalCost), cGreen, cardW),
		card("TOTAL TOKENS", fmtTokens(st.totalTokens), cCyan, cardW),
		card("TODAY", fmtMoney(st.todayCost), cYellow, cardW),
		card("BURN / HR", fmtMoney(st.burnHr), cMag, cardW),
	}, perRow)

	// ---- Panel sizing: side by side only when there's room ----
	sideBySide := inner >= 84
	actW, modelW := inner, inner
	if sideBySide {
		actW = (inner - 1) / 2
		modelW = inner - actW - 1
	}

	// ---- Activity (sparkline shrinks to last 12h when cramped) ----
	peak := 0.0
	for _, v := range st.hourly {
		if v > peak {
			peak = v
		}
	}
	hours := st.hourly[:]
	if actW-4 < 28 {
		hours = st.hourly[12:]
	}
	spark := lipgloss.NewStyle().Foreground(cGreen).Render(sparkline(hours))
	activity := lipgloss.JoinVertical(lipgloss.Left,
		fmt.Sprintf("%s %s", dim(fmt.Sprintf("%dh", len(hours))), spark),
		dim("peak "+fmtMoney(peak)+"/hr"),
		fmt.Sprintf("%s %s · %s", dim("5h"), txt(fmtMoney(st.h5Cost)), txt(fmtTokens(st.h5Tokens))),
		dim(fmt.Sprintf("rate ~%.0f tok/min", st.tokPerMin)),
	)

	// ---- By model (bar width adapts; bar dropped if no room) ----
	modelInner := clampi(modelW-4, 12, 999)
	nameW := clampi(modelInner/3, 8, 16)
	moneyW, pctW := 10, 4
	barW := modelInner - nameW - moneyW - pctW - 3
	var mb strings.Builder
	for _, r := range st.byModel {
		frac := 0.0
		if st.totalCost > 0 {
			frac = r.cost / st.totalCost
		}
		name := lipgloss.NewStyle().Foreground(cCyan).Render(padRight(r.model, nameW))
		pct := dim(fmt.Sprintf("%3.0f%%", frac*100))
		money := txt(padRight(fmtMoney(r.cost), moneyW))
		if barW >= 4 {
			bar := lipgloss.NewStyle().Foreground(cMag).Render(barChart(frac, barW))
			mb.WriteString(fmt.Sprintf("%s %s %s %s\n", name, bar, money, pct))
		} else {
			mb.WriteString(fmt.Sprintf("%s %s %s\n", name, money, pct))
		}
	}
	if mb.Len() == 0 {
		mb.WriteString(dim("no data"))
	}

	// ---- Recent sessions (drops MODEL/TOKENS columns when narrow) ----
	// Keep the trailing "\n" OUTSIDE dim()/txt(): a newline inside a styled
	// string makes lipgloss pad an empty 2nd line that bleeds into the next
	// row and wraps it.
	var rb strings.Builder
	if inner-4 >= 58 {
		rb.WriteString(dim(fmt.Sprintf("%s %s %s %s %s",
			padRight("PROJECT", 18), padRight("MODEL", 14),
			padRight("TOKENS", 9), padRight("COST", 11), "WHEN")) + "\n")
		for _, s := range st.recent {
			rb.WriteString(txt(fmt.Sprintf("%s %s %s %s %s",
				padRight(s.project, 18), padRight(shortModel(s.model), 14),
				padRight(fmtTokens(s.tokens), 9), padRight(fmtMoney(s.cost), 11), ago(s.last))) + "\n")
		}
	} else {
		projW := clampi(inner-4-24, 8, 22)
		rb.WriteString(dim(fmt.Sprintf("%s %s %s",
			padRight("PROJECT", projW), padRight("COST", 10), "WHEN")) + "\n")
		for _, s := range st.recent {
			rb.WriteString(txt(fmt.Sprintf("%s %s %s",
				padRight(s.project, projW), padRight(fmtMoney(s.cost), 10), ago(s.last))) + "\n")
		}
	}

	// ---- Assemble ----
	var row2 string
	if sideBySide {
		row2 = lipgloss.JoinHorizontal(lipgloss.Top,
			panel("◇ ACTIVITY", activity, cYellow, actW),
			" ",
			panel("◇ BY MODEL", strings.TrimRight(mb.String(), "\n"), cMag, modelW))
	} else {
		row2 = lipgloss.JoinVertical(lipgloss.Left,
			panel("◇ ACTIVITY", activity, cYellow, inner),
			"",
			panel("◇ BY MODEL", strings.TrimRight(mb.String(), "\n"), cMag, inner))
	}
	recent := panel("◇ RECENT SESSIONS", strings.TrimRight(rb.String(), "\n"), cCyan, inner)

	full := fmt.Sprintf("[r] refresh  [q] quit  [t] theme: %s      cost = API-equivalent estimate (not your bill)",
		themes[activeTheme].name)
	footer := dim(fmt.Sprintf("[t] %s  [q] quit", themes[activeTheme].name))
	if lipgloss.Width(full) <= inner {
		footer = dim(full)
	}

	return lipgloss.JoinVertical(lipgloss.Left, "", header, "", cards, "", row2, "", recent, "", footer)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func printStatsText(st stats) {
	fmt.Printf("Total spend : %s\n", fmtMoney(st.totalCost))
	fmt.Printf("Total tokens: %s  (in %s / out %s / cacheW %s / cacheR %s)\n",
		fmtTokens(st.totalTokens), fmtTokens(st.totalInput), fmtTokens(st.totalOutput),
		fmtTokens(st.totalCacheWrite), fmtTokens(st.totalCacheRead))
	fmt.Printf("Sessions    : %d    Messages: %d\n", st.sessions, st.msgs)
	fmt.Printf("Today       : %s  (%s tokens)\n", fmtMoney(st.todayCost), fmtTokens(st.todayTokens))
	fmt.Printf("Last 5h     : %s  (%s tokens)\n", fmtMoney(st.h5Cost), fmtTokens(st.h5Tokens))
	fmt.Printf("Burn (1h)   : %s/hr  ~%.0f tok/min\n", fmtMoney(st.burnHr), st.tokPerMin)
	fmt.Println("By model:")
	for _, r := range st.byModel {
		fmt.Printf("  %-16s %-12s %s\n", r.model, fmtMoney(r.cost), fmtTokens(r.tokens))
	}
	fmt.Println("Recent sessions:")
	for _, s := range st.recent {
		fmt.Printf("  %-18s %-12s %8s  %-10s %s\n",
			s.project, shortModel(s.model), fmtTokens(s.tokens), fmtMoney(s.cost), ago(s.last))
	}
}

// statuslinePayload is the compact JSON the statusline script reads. The
// per-session model/context/cost come from Claude Code's own statusline stdin;
// these are the cross-session aggregates only claudewatch can compute.
type statuslinePayload struct {
	Total     float64 `json:"total"`
	Today     float64 `json:"today"`
	Burn      float64 `json:"burn"`
	H5        float64 `json:"h5"`
	TokPerMin float64 `json:"tok_per_min"`
	Sessions  int     `json:"sessions"`
}

func statuslineCachePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claudewatch-statusline.json")
}

// writeStatuslineCache persists the aggregates to a tiny JSON file (read
// instantly by the statusline) and also echoes them to stdout.
func writeStatuslineCache(st stats) {
	b, _ := json.Marshal(statuslinePayload{
		Total: st.totalCost, Today: st.todayCost, Burn: st.burnHr,
		H5: st.h5Cost, TokPerMin: st.tokPerMin, Sessions: st.sessions,
	})
	if f := statuslineCachePath(); f != "" {
		_ = os.WriteFile(f, b, 0o644)
	}
	fmt.Println(string(b))
}

func main() {
	statsFlag := flag.Bool("stats", false, "print a one-shot text summary and exit")
	rootFlag := flag.String("root", "", "Claude projects dir (default ~/.claude/projects)")
	themeFlag := flag.String("theme", "", "color theme: "+themeNames())
	statuslineFlag := flag.Bool("statusline", false, "write the statusline cache (~/.claudewatch-statusline.json) as JSON and exit")
	flag.Parse()

	// Remembered theme first, then let an explicit --theme override and persist it.
	loadThemePref()
	if *themeFlag != "" {
		if i := themeByName(*themeFlag); i >= 0 {
			applyTheme(i)
			saveThemePref()
		} else {
			fmt.Printf("unknown theme %q; options: %s\n", *themeFlag, themeNames())
			os.Exit(1)
		}
	}

	root := *rootFlag
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Println("cannot resolve home dir:", err)
			os.Exit(1)
		}
		root = filepath.Join(home, ".claude", "projects")
	}

	sc := &scanner{root: root, cache: map[string]fileAgg{}}

	if *statsFlag {
		printStatsText(sc.scan())
		return
	}

	if *statuslineFlag {
		writeStatuslineCache(sc.scan())
		return
	}

	p := tea.NewProgram(model{sc: sc, st: sc.scan()}, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Println("error:", err)
		os.Exit(1)
	}
}
