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
  <key>CFBundleIdentifier</key><string>com.eugene.linkedin-assistant.jobs</string>
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
if pkill -f "Jobs.app/Contents/MacOS/jobs"; then
  sleep 1
  if launchctl print "gui/$(id -u)/com.eugene.jobs-badge" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.eugene.jobs-badge" && echo "  relaunched via launchd (com.eugene.jobs-badge)"
  else
    open -g -a "$APP" --args --background && echo "  relaunched (badge daemon)"
  fi
fi

echo "Done. Test:  open -a \"$APP\"   (badge daemon: open -g -a \"$APP\" --args --background)"
