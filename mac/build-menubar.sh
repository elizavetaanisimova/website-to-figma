#!/bin/bash
# Собирает иконку строки меню в mac/Site to Figma.app
# Требуется Xcode Command Line Tools (swiftc). Вызывается из install.command.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/menubar/main.swift"
APP="$SCRIPT_DIR/Site to Figma.app"

command -v swiftc >/dev/null 2>&1 || {
  echo "swiftc не найден — установите Xcode Command Line Tools: xcode-select --install"
  exit 1
}
[ -f "$SRC" ] || { echo "Не найден $SRC"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Site to Figma</string>
  <key>CFBundleDisplayName</key><string>Site to Figma</string>
  <key>CFBundleIdentifier</key><string>com.sitetofigma.menubar</string>
  <key>CFBundleExecutable</key><string>SiteToFigma</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

swiftc -swift-version 5 -O \
  -target "$(uname -m)-apple-macos12.0" \
  -framework Cocoa \
  -o "$APP/Contents/MacOS/SiteToFigma" \
  "$SRC"

# ad-hoc подпись, чтобы macOS не ругался на неподписанный бинарник
codesign --force --sign - "$APP" 2>/dev/null || true

echo "Собрано: $APP"
