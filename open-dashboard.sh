#!/bin/bash
# Regenerate the dashboard, ensure the state server is running on 127.0.0.1:7777,
# then open it in the default browser. Idempotent: a second call reuses the
# already-running server instead of starting a duplicate.
set -euo pipefail
cd "$(dirname "$0")"

# launchd/Finder give us a bare PATH: prefer node on PATH, else the newest nvm one.
if ! NODE="$(command -v node)"; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -x "${NODE:-}" ] || { echo "open-dashboard.sh: node not found (PATH or ~/.nvm)" >&2; exit 1; }

"$NODE" dashboard.mjs   # regenerate applications/index.html (no --open)

# Start the server only if port 7777 is not already listening. The nc check
# alone is a race (two launchers can both see "not listening"), so the actual
# start is guarded by an atomic mkdir lock: the winner starts the server and
# drops the lock once the port is bound; everyone else just waits for the port.
mkdir -p logs   # ensure the nohup log target exists (fresh clones lack logs/)
LOCK=state-server.lock
WON=0
if ! /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
  # A launcher killed between mkdir and rmdir would leave the lock forever;
  # the start window is ~2s, so a lock older than a minute is stale.
  find "$LOCK" -maxdepth 0 -type d -mmin +1 -exec rmdir {} \; 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    WON=1
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT   # released even on Ctrl-C / set -e abort
    nohup "$NODE" state-server.mjs >> "logs/state-server.log" 2>&1 &   # append: keep earlier crash output
  fi
  # Give it a moment to bind before we open the browser.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1 && break
    sleep 0.2
  done
  # Only the mkdir winner drops the lock (via the EXIT trap): a loser removing
  # it would reopen the start window for a third launcher mid-bind.
  if ! /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
    echo "open-dashboard.sh: state server did not start (lock: $LOCK, WON=$WON); see logs/state-server.log" >&2
    exit 1
  fi
fi

open "http://127.0.0.1:7777/"
