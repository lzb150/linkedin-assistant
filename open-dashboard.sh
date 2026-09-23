#!/usr/bin/env bash
# Dock-click helper: regenerate the dashboard and open it. The state server on
# 127.0.0.1:7777 is a launchd agent (com.example.state-server.plist.example).
set -euo pipefail
cd "$(dirname "$0")"

# launchd/Finder give us a bare PATH: prefer node on PATH, else the newest nvm one.
if ! NODE="$(command -v node)"; then
  NODE="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/node | sort -V | tail -1)"
fi
[[ -x "${NODE:-}" ]] || { echo "open-dashboard.sh: node not found (PATH or ~/.nvm)" >&2; exit 1; }

# One corrupt package must not block opening the previous build.
"$NODE" dashboard.mjs || echo "dashboard rebuild failed; opening previous build" >&2

# Server down (agent not installed / not yet up): open the generated file read-only —
# the client has an offline mode — instead of a "connection refused" tab. stderr is
# invisible from a Dock click, so the fallback has to be the behaviour, not a message.
if /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
  open "http://127.0.0.1:7777/"
else
  echo "open-dashboard.sh: state server not running — opening a read-only copy; install com.example.state-server.plist.example (README → Schedule it)" >&2
  # `set -e` would abort here on a fresh clone where dashboard.mjs has never
  # succeeded — the one case this fallback exists for. Say what is missing.
  if [[ -f applications/index.html ]]; then
    open "applications/index.html"
  else
    echo "open-dashboard.sh: applications/index.html does not exist yet — run 'node jobs.mjs' first" >&2
    exit 1
  fi
fi
