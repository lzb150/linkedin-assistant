#!/bin/bash
# Regenerate the dashboard, ensure the state server is running on 127.0.0.1:7777,
# then open it in the default browser. Idempotent: a second call reuses the
# already-running server instead of starting a duplicate.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"

node dashboard.mjs   # regenerate applications/index.html (no --open)

# Start the server only if port 7777 is not already listening.
mkdir -p logs   # ensure the nohup log target exists (fresh clones lack logs/)
if ! /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
  nohup node state-server.mjs >> "logs/state-server.log" 2>&1 &
  # Give it a moment to bind before we open the browser.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

open "http://127.0.0.1:7777/"
