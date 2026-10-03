#!/bin/bash
# Builds "Moonstone Dictate.app" into ~/Applications, where server.js looks for it by default
# (override with "dictate": {"app": "/path/to/Moonstone Dictate.app"} in config.json).
#
# Signing: pass a stable code-signing identity so macOS keeps the Accessibility permission across
# rebuilds. List yours with `security find-identity -v -p codesigning`, then:
#   ./build.sh "Apple Development: Your Name (XXXXXXXXXX)"
# With no argument the app is signed ad-hoc ("-"), which works, but every rebuild needs the
# permission granted again in System Settings > Privacy & Security > Accessibility.
set -euo pipefail
cd "$(dirname "$0")"
IDENTITY="${1:--}"
APP="$HOME/Applications/Moonstone Dictate.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O dictate.swift -o "$APP/Contents/MacOS/dictate"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force -s "$IDENTITY" "$APP"
swiftc -O micon.swift -o micon
echo "built $APP"
echo "first run: open -g \"$APP\" --args check   (then allow it under Accessibility)"
