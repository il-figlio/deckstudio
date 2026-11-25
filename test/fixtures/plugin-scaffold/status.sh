#!/bin/sh
# Scratch Plug status script for DeckStudio (deckstudio.json → status.cmd / actions).
# DeckStudio runs it directly (no shell string): "status.sh" prints the status JSON, "status.sh bump N" / "reset" are actions.
# Keep output small JSON with updated_at, so a crashed tool shows as stale instead of busy.
STATE="${DECK_PLUGIN_DIR:-$(dirname "$0")}/.count"
n=$(cat "$STATE" 2>/dev/null || echo 0)
case "$1" in
  bump)  by=${2:-1}; case "$by" in ''|*[!0-9-]*) by=1;; esac; n=$((n + by)); echo "$n" > "$STATE"; echo "count $n"; exit 0;;
  reset) echo 0 > "$STATE"; exit 0;;
esac
printf '{"state":"ok","count":%s,"updated_at":%s}\n' "$n" "$(date +%s)"
