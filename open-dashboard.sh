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

# Regenerate applications/index.html (no --open); one corrupt package must not
# block opening the previous build.
"$NODE" dashboard.mjs || echo "dashboard rebuild failed; opening previous build" >&2

# Start the server only if port 7777 is not already listening. The nc check
# alone is a race (two launchers can both see "not listening"), so the actual
# start is guarded by an atomic mkdir lock: the winner starts the server and
# drops the lock once the port is bound; everyone else just waits for the port.
mkdir -p logs   # ensure the nohup log target exists (fresh clones lack logs/)
# A server started before the last update keeps old code (status list, store
# normalizer). /health reports its start time; if any server source is newer,
# stop it here and let the start block below bring up a fresh one.
if /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
  # No "started" in the reply = a server from before this check existed → treat as 0 (stale).
  STARTED="$(curl -s -m 2 http://127.0.0.1:7777/health | sed -n 's/.*"started":\([0-9]*\).*/\1/p')"
  STARTED="${STARTED:-0}"
  {
    NEWEST=0
    for f in state-server.mjs lib/job-state.mjs lib/json-file.mjs lib/dashboard-client-core.cjs; do
      m="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")"; [ "$m" -gt "$NEWEST" ] && NEWEST="$m"
    done
    if [ "$NEWEST" -gt "$STARTED" ]; then
      echo "open-dashboard.sh: state server predates an update — restarting" >&2
      pkill -f "state-server.mjs" || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1 || break; sleep 0.2; done
    fi
  }
fi
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
