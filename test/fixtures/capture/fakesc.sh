#!/bin/sh
# fake /usr/sbin/screencapture. Logs args to $FAKE_LOG, then behaves per $FAKE_SC:
# rec (wait for INT, write last arg), err-window, err-rect0, err-save, perm-save, nofile, slow (sleep then write)
echo "$$ $*" >> "${FAKE_LOG:-/dev/null}"
for last; do :; done
case "$FAKE_SC" in
  rec) trap 'printf movie > "$last"; exit 0' INT; while true; do sleep 0.1; done ;;
  err-window) echo "could not create image from window" >&2; exit 1 ;;
  err-rect0) echo "could not create image from rect" >&2; exit 0 ;;
  err-save) echo "screencapture: cannot write file to intended destination, $last" >&2; exit 0 ;;
  nofile) exit 0 ;;
  perm-save) echo "You don't have permission to save files in the location where screen shots are stored." >&2; exit 1 ;;
  slow) trap 'exit 130' INT; sleep 2; printf img > "$last"; exit 0 ;;
esac
