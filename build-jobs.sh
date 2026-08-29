#!/usr/bin/env bash
# Build Jobs.app — the "Вакансии" launcher that also shows the unread LinkedIn
# message count as a red Dock badge. The built .app is git-ignored;
# commit this script + jobs-app.swift + jobs.icns instead.
#
# After building, start it once:  open -a ./Jobs.app
# Autostart at login via com.example.jobs-badge.plist.example (see README).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/Jobs.app"

echo "Building $APP …"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Вакансии</string>
  <key>CFBundleDisplayName</key><string>Вакансии</string>
  <key>CFBundleIdentifier</key><string>com.eugene.linkedin-assistant.jobs.v2</string>
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
if [ -f "$DIR/jobs.icns" ]; then
  cp "$DIR/jobs.icns" "$APP/Contents/Resources/AppIcon.icns"
  echo "  icon: copied jobs.icns"
else
  echo "  icon: WARNING — jobs.icns missing, app will use a generic icon"
fi

# Compile the Swift app into the bundle.
xcrun swiftc -O -framework Cocoa \
  -o "$APP/Contents/MacOS/jobs" "$DIR/jobs-app.swift"

# Ad-hoc sign for a stable identity.
codesign --force --sign - "$APP"

# Register with LaunchServices so `open -a` recognizes it.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" && echo "  registered with LaunchServices"

# A running instance keeps executing the OLD binary: `open -a` on a running app
# only re-opens it (and `launchctl kickstart -k` restarts just the `open -W`
# wrapper). Kill it so launchd / the next ensureJobsApp() starts the fresh build.
# Label of the installed launchd agent (override: JOBS_BADGE_LABEL=... ./build-jobs.sh).
LABEL="${JOBS_BADGE_LABEL:-}"
if [ -z "$LABEL" ]; then
  for cand in com.example.jobs-badge com.eugene.jobs-badge; do
    launchctl print "gui/$(id -u)/$cand" >/dev/null 2>&1 && { LABEL="$cand"; break; }
  done
fi
# Relaunch only what was running (a fresh clone stays quiet — see "Test:" below).
if pkill -f "$APP/Contents/MacOS/jobs"; then
  sleep 1
  if [ -n "$LABEL" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL" && echo "  relaunched via launchd ($LABEL)" \
      || echo "  WARNING: launchctl kickstart failed — start it manually: open -g -a \"$APP\" --args --background"
  else
    open -g -a "$APP" --args --background && echo "  relaunched (badge daemon, no launchd agent found)" \
      || echo "  WARNING: open failed — start it manually: open -g -a \"$APP\" --args --background"
  fi
fi

echo "Done. Test:  open -a \"$APP\"   (badge daemon: open -g -a \"$APP\" --args --background)"
