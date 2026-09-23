#!/usr/bin/env bash
# Build Jobs.app — the "Jobs" launcher that also shows the unread LinkedIn
# message count as a red Dock badge. The built .app is git-ignored;
# commit this script + jobs-app.swift + jobs.icns instead.
#
# After building, start it once:  open -a ./Jobs.app
# Autostart at login via com.example.jobs-badge.plist.example (see README).
set -euo pipefail

# Bundle identifier. macOS keys notification permission, the Dock tile and
# LaunchServices registration off this string, so changing it on a machine where
# Jobs.app is already installed orphans the old app and drops its granted
# permissions. It therefore stays overridable rather than renamed: every other
# user-facing template uses a com.example. placeholder, and a clone that leaves
# this unset would otherwise ship under the author's personal identifier.
#   BUNDLE_ID=com.you.linkedin-assistant.jobs ./build-jobs.sh
BUNDLE_ID="${BUNDLE_ID:-com.eugene.linkedin-assistant.jobs.v2}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/Jobs.app"

echo "Building $APP …"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Unquoted heredoc so ${BUNDLE_ID} expands; the plist has no other $ or backtick.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jobs</string>
  <key>CFBundleDisplayName</key><string>Jobs</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>jobs</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Icon: jobs.icns.
if [[ -f "$DIR/jobs.icns" ]]; then
  cp "$DIR/jobs.icns" "$APP/Contents/Resources/AppIcon.icns"
  echo "  icon: copied jobs.icns"
else
  echo "  icon: WARNING — jobs.icns missing, app will use a generic icon"
fi

# Compile the Swift app into the bundle.
# -target pins the deployment floor to the LSMinimumSystemVersion written into
# Info.plist above. Without it the binary inherits the build machine's macOS
# version, so a bundle claiming 13.0 could refuse to launch on 13.0.
xcrun swiftc -O -framework Cocoa \
  -target "$(uname -m)-apple-macos13.0" \
  -o "$APP/Contents/MacOS/jobs" "$DIR/jobs-app.swift"

# Ad-hoc sign for a stable identity.
codesign --force --sign - "$APP"

# Register with LaunchServices so `open -a` recognizes it.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREG" ]]; then
  if "$LSREG" -f "$APP"; then echo "  registered with LaunchServices"
  else echo "  WARNING — lsregister failed; \`open -a\` may not find the app until it is re-registered" >&2; fi
fi

# A running instance keeps executing the OLD binary: `open -a` on a running app
# only re-opens it. Kill it; the jobs-badge launchd agent (KeepAlive) relaunches
# the fresh build by itself. Without an agent, start it by hand (see "Test:" below).
# pkill/pgrep -f match the WHOLE command line against an ERE. "." and "/" only
# widen the match harmlessly, but a project path containing + ( [ * ? either
# widens it further or fails to compile — and since the call sits in `if`, a
# compile failure is just a false branch: nothing is killed, the stale daemon
# keeps running the old binary, and the script still says "Done". Escape every
# ERE metacharacter in the path first.
BIN_RE=$(printf '%s' "$APP/Contents/MacOS/jobs" | sed 's/[][\.^$*+?(){}|\\\/]/\\&/g')
if pkill -f "$BIN_RE"; then
  sleep 2
  pgrep -f "$BIN_RE" >/dev/null && echo "  relaunched by launchd" \
    || echo "  stopped the old badge daemon — no launchd agent relaunched it; start it: open -g -a \"$APP\" --args --background"
fi

echo "Done. Test:  open -a \"$APP\"   (badge daemon: open -g -a \"$APP\" --args --background)"
