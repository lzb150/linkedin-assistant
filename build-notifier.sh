#!/usr/bin/env bash
# Build Notifier.app — a tiny signed bundle that posts iPhone-style "Messages"
# banners (green Messages icon) via UserNotifications. See notifier.swift.
# The built .app is git-ignored; commit this script + notifier.swift instead.
#
# After building, grant notification permission ONCE:
#   open -n -a ./Notifier.app --args "Test" "hello"
# and click Allow (or enable it in System Settings > Notifications).
#
# NOTE: ad-hoc signing gives the app a new identity every build, which RESETS
# the granted notification permission. If a rebuild stops showing banners, bump
# CFBundleIdentifier below to a fresh value (clean "not determined" state) and
# grant again via `open`. So: build rarely; don't rebuild casually.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/Notifier.app"
MSG_ICON="/System/Applications/Messages.app/Contents/Resources/AppIcon.icns"

echo "Building $APP …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Messages</string>
  <key>CFBundleDisplayName</key><string>Messages</string>
  <key>CFBundleIdentifier</key><string>com.eugene.linkedin-assistant.notify</string>
  <key>CFBundleExecutable</key><string>notifier</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Green Messages icon → notification banner icon. The system Messages.icns holds
# only one large representation; a notification banner needs the SMALL sizes too,
# or macOS renders a generic icon. So rebuild a COMPLETE multi-size .icns from
# the Messages artwork via an iconset.
if [ -f "$MSG_ICON" ] && [ "$(stat -f%z "$MSG_ICON")" -gt 1000 ]; then
  TMP="$(mktemp -d)"
  SRC="$TMP/src.png"
  ISET="$TMP/AppIcon.iconset"
  mkdir -p "$ISET"
  sips -s format png "$MSG_ICON" --out "$SRC" >/dev/null 2>&1
  # label:pixels — exact iconset filenames macOS/iconutil expect.
  for spec in 16x16:16 16x16@2x:32 32x32:32 32x32@2x:64 \
              128x128:128 128x128@2x:256 256x256:256 256x256@2x:512 \
              512x512:512 512x512@2x:1024; do
    label="${spec%%:*}"; size="${spec##*:}"
    sips -z "$size" "$size" "$SRC" --out "$ISET/icon_${label}.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$ISET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null; then
    echo "  icon: built multi-size AppIcon.icns from Messages artwork"
  else
    cp "$MSG_ICON" "$APP/Contents/Resources/AppIcon.icns"
    echo "  icon: iconutil failed, copied raw Messages icns"
  fi
  rm -rf "$TMP"
else
  echo "  icon: WARNING — Messages icns not usable, banner will use a generic icon"
fi

# Compile the Swift helper into the bundle.
xcrun swiftc -O -framework UserNotifications \
  -o "$APP/Contents/MacOS/notifier" "$DIR/notifier.swift"

# Ad-hoc sign so TCC has a stable identity for the notification permission.
codesign --force --sign - "$APP"

# Register with LaunchServices so `open -a` recognizes it. UserNotifications
# rejects a bare exec ("Notifications are not allowed"); it must be opened as a
# real registered app — which is how check.mjs invokes it.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" && echo "  registered with LaunchServices"

echo "Done. Test:  open -n -a \"$APP\" --args \"Helen Rozen\" \"hello from LinkedIn\""
