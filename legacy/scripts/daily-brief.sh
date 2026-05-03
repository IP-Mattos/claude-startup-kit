#!/usr/bin/env bash
# Daily Brief hook: runs once per calendar day at SessionStart.
# Outputs a structured project list the model uses to build a welcome menu.
set -uo pipefail

STATE_FILE="$HOME/.claude/scripts/.daily-brief-last-date"
LOG_FILE="$HOME/.claude/logs/startup-kit.log"
TODAY=$(date +%Y%m%d)

log_kit() {
  local level="$1"; shift
  local msg="$*"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '[%s] [%s] [daily-brief] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

log_kit INFO "Hook fired"

if [ -f "$STATE_FILE" ]; then
  LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "00000000")
  if [ "$LAST" = "$TODAY" ]; then
    log_kit INFO "Skipped (already ran today: $LAST)"
    exit 0
  fi
fi

python - "$TODAY" <<'PYEOF'
import json
import os
import sys
import time
from pathlib import Path

today = sys.argv[1]
home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
projects_dir = home / ".claude" / "projects"
state_file = home / ".claude" / "scripts" / ".daily-brief-last-date"

if not projects_dir.is_dir():
    state_file.write_text(today)
    sys.exit(0)

now = time.time()
cutoff = now - 14 * 86400

entries = []
for pdir in projects_dir.iterdir():
    if not pdir.is_dir():
        continue
    try:
        mtime = pdir.stat().st_mtime
    except OSError:
        continue
    if mtime < cutoff:
        continue

    jsonls = sorted(pdir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    cwd = None
    for jpath in jsonls:
        try:
            with jpath.open("r", encoding="utf-8") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and obj.get("cwd"):
                        cwd = obj["cwd"]
                        break
            if cwd:
                break
        except OSError:
            continue

    if not cwd:
        continue

    days_ago = int((now - mtime) // 86400)
    last_date = time.strftime("%Y-%m-%d", time.localtime(mtime))
    entries.append((mtime, days_ago, last_date, cwd))

entries.sort(key=lambda e: e[0], reverse=True)

if not entries:
    state_file.write_text(today)
    sys.exit(0)

print(f"[daily-brief:trigger] First Claude Code session of {today}")
print("[daily-brief:projects-start]")
for i, (_, days_ago, last_date, cwd) in enumerate(entries, start=1):
    if days_ago == 0:
        label = "today"
    elif days_ago == 1:
        label = "yesterday"
    else:
        label = f"{days_ago}d ago"
    print(f"{i}. {cwd} | last: {last_date} ({label})")
print("[daily-brief:projects-end]")

state_file.write_text(today)
PYEOF
