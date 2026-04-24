#!/usr/bin/env bash
# SessionStart hook: daily gentle-ai version check + auto-upgrade.
# Silent when last check was < 24h ago, so it only runs once per day.
set -uo pipefail

STATE_FILE="$HOME/.claude/scripts/.gentle-ai-last-check"
LOG_FILE="$HOME/.claude/logs/startup-kit.log"
NOW=$(date +%s)
THRESHOLD=$((24 * 60 * 60))

log_kit() {
  local level="$1"; shift
  local msg="$*"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '[%s] [%s] [check-gentle-ai] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

log_kit INFO "Hook fired"

if [ -f "$STATE_FILE" ]; then
  LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt $THRESHOLD ]; then
    log_kit INFO "Skipped (last check $((NOW - LAST))s ago, < 24h)"
    exit 0
  fi
fi

if ! command -v gentle-ai >/dev/null 2>&1; then
  echo "[gentle-ai] Not installed on this machine. Skipping daily check."
  exit 0
fi

INSTALLED=$(gentle-ai version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ -z "$INSTALLED" ] && INSTALLED="unknown"

LATEST_RAW=$(curl -sfL --max-time 10 https://api.github.com/repos/Gentleman-Programming/gentle-ai/releases/latest 2>/dev/null || true)
LATEST=$(printf '%s' "$LATEST_RAW" | grep -oE '"tag_name":[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

if [ -z "$LATEST" ]; then
  echo "[gentle-ai] Could not reach GitHub (network issue?). Will retry next session after 24h."
  exit 0
fi

if [ "$INSTALLED" = "$LATEST" ]; then
  echo "[gentle-ai] Up to date — v$INSTALLED."
  echo "$NOW" > "$STATE_FILE"
  exit 0
fi

echo "[gentle-ai] Update available: v$INSTALLED → v$LATEST. Upgrading now..."

if powershell.exe -Command "irm https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.ps1 | iex" >/tmp/gentle-ai-upgrade.log 2>&1; then
  NEW_INSTALLED=$(gentle-ai version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ -z "$NEW_INSTALLED" ] && NEW_INSTALLED="unknown"
  echo "[gentle-ai] Upgraded successfully: v$INSTALLED → v$NEW_INSTALLED"
  echo "[gentle-ai] Release notes: https://github.com/Gentleman-Programming/gentle-ai/releases/tag/v$LATEST"
  echo "$NOW" > "$STATE_FILE"
else
  echo "[gentle-ai] Upgrade FAILED. See /tmp/gentle-ai-upgrade.log for details. Will retry next session after 24h."
fi
