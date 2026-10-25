#!/bin/bash
# Builds Moonstone.app (a window around the Moonstone page) into ~/Applications.
# It opens http://127.0.0.1:8899/ (or $DOCK_PORT); pass another URL as an argument when launching:
#   open ~/Applications/Moonstone.app --args http://127.0.0.1:8899/
# Dropping Finder items onto it works like a terminal: pictures attach, anything else drops its full path.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-$HOME/Applications}/Moonstone.app"
mkdir -p build
swiftc -O main.swift -o build/Moonstone -framework Cocoa -framework WebKit
rm -rf "$OUT"; mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp build/Moonstone "$OUT/Contents/MacOS/"
cp ../../icon/Moonstone.icns "$OUT/Contents/Resources/"
cp Info.plist "$OUT/Contents/"
codesign --force --deep -s - "$OUT"
rm -rf build
echo "built $OUT"
