# Roadmap — Claude Startup Kit

What's on the table beyond the current `1.4.x` line. These are deliberately scoped
as their own efforts because they don't fit a single iteration cycle.

## Cross-platform support (Mac / Linux)

**Goal**: rewrite `startup-brief.ps1` as a small native binary so the kit
runs on macOS and Linux too, and ships with sub-100ms cold start.

**Tradeoffs**:
- **Go** — fastest path, single static binary, easy cross-compilation. Loses
  some Windows-specific niceties (font sizing via WinAPI), so `--font-size`
  becomes user-managed in the terminal config. About 600–800 LOC of Go.
- **Rust** — also viable. Slightly more upfront cost (cargo + crate setup) but
  better story for ANSI rendering with the `crossterm` crate. ~700–900 LOC.
- **Pure shell + per-OS branches** — lowest engineering cost, highest
  maintenance cost. Discarded.

**Acceptance criteria**:
- Single binary per platform (`claude-brief-windows-amd64.exe`,
  `claude-brief-darwin-arm64`, `claude-brief-linux-amd64`).
- Reads the same `startup-kit-config.json` schema.
- Calls the same `engram` and `git` CLIs.
- Renders the v1.3+ layout identically across OSes.
- Cold start < 100 ms on a 2024 laptop.
- macOS launch via `launchd` plist; Linux launch via systemd `--user` service
  or `~/.config/autostart/`.

**Estimated effort**: 3–5 days of focused work + a release pipeline.

---

## Distribution via Choco / Scoop

**Goal**: `scoop install claude-startup-kit` (Windows) and `brew install
claude-startup-kit` (macOS) — once cross-platform is done.

**Tradeoffs**:
- Requires the cross-platform binary first (precondition).
- Choco needs a NuGet `.nuspec` and either a public or paid feed; Scoop needs a
  bucket repo with manifest JSON.
- Brew needs a tap repo + formula in Ruby.
- Each channel is a separate maintenance burden (version bumps, signing, deprecations).

**Acceptance criteria**:
- A GitHub Actions release workflow produces signed binaries on tag push.
- `scoop bucket add ip-mattos https://github.com/IP-Mattos/scoop-bucket && scoop install claude-startup-kit` works.
- A `brew tap` formula exists with the same.
- Release notes auto-generated from `CHANGELOG.md`.

**Estimated effort**: 2–3 days *after* cross-platform binary lands.

---

## Pomodoro / focus mode (NOT planned — deliberately excluded by user)
## AI-suggested project (NOT planned — deliberately excluded by user)

These two were considered and excluded. They're listed here so they don't get
re-proposed by mistake in future planning.
