#!/bin/bash
# Moonstone uninstaller for macOS.
#   curl -fsSL https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/uninstall.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/uninstall.sh | bash -s -- --purge
# or:  bash ~/moonstone/uninstall.sh [--purge]
#
# Stops and removes the LaunchAgent(s) and the chat-send command. Keeps the checkout,
# config.json and state unless --purge is given. Same MOONSTONE_DIR / MOONSTONE_LABEL /
# KIT_BIN_DIR as install.sh.
set -euo pipefail

PURGE=0
for a in "$@"; do
    case "$a" in
        --purge) PURGE=1 ;;
        -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null; exit 0 ;;
        *) printf '[moonstone] unknown option: %s\n' "$a" >&2; exit 2 ;;
    esac
done

DIR="${MOONSTONE_DIR:-$HOME/moonstone}"
LABEL="${MOONSTONE_LABEL:-com.nicedreamzapp.moonstone}"
BIN_DIR="${KIT_BIN_DIR:-$HOME/.local/bin}"
AGENTS="$HOME/Library/LaunchAgents"
MARK="# installed by moonstone install.sh"

say() { printf '[moonstone] %s\n' "$*"; }
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { say "bad MOONSTONE_LABEL"; exit 2; }

is_checkout() { [ -f "$1/server.js" ] && [ -f "$1/updater.js" ]; }
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then
    here="$(cd "$(dirname "$src")" && pwd)"
    if is_checkout "$here"; then DIR="$here"; fi
fi

for l in "$LABEL.updater" "$LABEL"; do
    if launchctl bootout "gui/$(id -u)/$l" >/dev/null 2>&1; then say "stopped $l"; fi
    if [ -f "$AGENTS/$l.plist" ]; then rm -f "$AGENTS/$l.plist"; say "removed $AGENTS/$l.plist"; fi
done

CS="$BIN_DIR/chat-send"
if [ -f "$CS" ] && grep -qF "$MARK" "$CS" 2>/dev/null; then
    rm -f "$CS"; say "removed $CS"
fi

if [ "$PURGE" = 1 ]; then
    for f in "$HOME/Library/Logs/moonstone.log" "$HOME/Library/Logs/moonstone-updater.log"; do
        if [ -f "$f" ]; then rm -f "$f"; say "removed $f"; fi
    done
    if is_checkout "$DIR"; then
        cd /
        rm -rf "$DIR"; say "removed $DIR (config.json and state included)"
    fi
else
    say "kept $DIR with config.json and state (use --purge to delete it)"
fi
say "done"
