#!/bin/bash
# Moonstone installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/install.sh | bash
# or, from a checkout:  bash install.sh
#
# Environment (all optional):
#   MOONSTONE_DIR         where to clone (default ~/moonstone; ignored when run from a checkout)
#   MOONSTONE_REPO        git URL or local path to clone from
#   DOCK_PORT             port the server listens on (default 8899; MOONSTONE_PORT works too)
#   MOONSTONE_LABEL       LaunchAgent label (default com.nicedreamzapp.moonstone)
#   MOONSTONE_NODE        Node 18+ binary to run it with
#   MOONSTONE_AUTOUPDATE  set to 1 to also run updater.js every 5 minutes (label <label>.updater)
#   KIT_BIN_DIR           where the chat-send command goes (default ~/.local/bin)
set -euo pipefail

REPO_URL="${MOONSTONE_REPO:-https://github.com/nicedreamzapp/moonstone}"
DIR="${MOONSTONE_DIR:-$HOME/moonstone}"
PORT="${DOCK_PORT:-${MOONSTONE_PORT:-8899}}"
LABEL="${MOONSTONE_LABEL:-com.nicedreamzapp.moonstone}"
ULABEL="$LABEL.updater"
BIN_DIR="${KIT_BIN_DIR:-$HOME/.local/bin}"
AGENTS="$HOME/Library/LaunchAgents"
LOG="$HOME/Library/Logs/moonstone.log"
ULOG="$HOME/Library/Logs/moonstone-updater.log"
MARK="# installed by moonstone install.sh"

say() { printf '[moonstone] %s\n' "$*"; }
die() { printf '[moonstone] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS. Elsewhere run: node server.js (see the README)."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "DOCK_PORT must be a number"
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "MOONSTONE_LABEL may only hold letters, digits, dot, dash, underscore"

# --- 1. Node 18+ ----------------------------------------------------------
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
NODE=""
if [ -n "${MOONSTONE_NODE:-}" ]; then
    node_ok "$MOONSTONE_NODE" || die "MOONSTONE_NODE=$MOONSTONE_NODE is not Node 18+"
    NODE="$MOONSTONE_NODE"
else
    for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
        if [ -n "$cand" ] && node_ok "$cand"; then NODE="$cand"; break; fi
    done
fi
if [ -z "$NODE" ]; then
    old="$(command -v node 2>/dev/null || true)"
    [ -n "$old" ] && say "found $old ($("$old" -v 2>/dev/null)), but Moonstone needs Node 18 or newer"
    die "Node 18+ not found. Install it with 'brew install node' or from https://nodejs.org then re-run."
fi
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

# --- 2. Checkout ----------------------------------------------------------
is_checkout() { [ -f "$1/server.js" ] && [ -f "$1/updater.js" ] && git -C "$1" rev-parse --git-dir >/dev/null 2>&1; }

src="${BASH_SOURCE[0]:-}"
here=""
if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd)"; fi
if [ -n "$here" ] && is_checkout "$here"; then
    DIR="$here"
    say "using this checkout: $DIR"
elif [ -d "$DIR/.git" ]; then
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
        say "local edits in $DIR, skipping git pull"
    else
        say "updating $DIR"
        git -C "$DIR" pull --ff-only --quiet || say "git pull failed, continuing with the current copy"
    fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not a git checkout. Move it or set MOONSTONE_DIR."
else
    command -v git >/dev/null || die "git not found. Install the Xcode command line tools: xcode-select --install"
    say "cloning $REPO_URL into $DIR"
    git clone --quiet "$REPO_URL" "$DIR"
fi
is_checkout "$DIR" || die "$DIR does not look like a Moonstone checkout"
"$NODE" --check "$DIR/server.js" || die "server.js does not parse with $NODE"

# --- 3. config.json (only when there is none) -----------------------------
UID_N="$(id -u)"
if [ -f "$DIR/config.json" ]; then
    say "keeping $DIR/config.json"
else
    # A minimal config instead of config.example.json: the example lists demo peers and launchers
    # that do not exist here. One Claude Code launcher in your home folder, no peers, no warm spares.
    NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
    # shellcheck disable=SC2016  # the ${...} below is JavaScript, not shell
    MOON_NAME="$NAME" MOON_UID="$UID_N" MOON_LABEL="$LABEL" MOON_PORT="$PORT" \
    "$NODE" -e '
      const e = process.env;
      const cfg = {
        machine: "local", name: e.MOON_NAME || "This Mac", peers: [], warm: [],
        launchers: [{ label: "Claude Code", group: "main", cwd: "~", mode: "default" }],
        autoupdate: { branch: "main", port: +e.MOON_PORT,
                      restart: ["launchctl", "kickstart", "-k", `gui/${e.MOON_UID}/${e.MOON_LABEL}`] }
      };
      require("fs").writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + "\n");
    ' "$DIR/config.json"
    say "wrote a starter $DIR/config.json (see config.example.json for launchers and peers)"
fi

# --- 4. chat-send on PATH ---------------------------------------------------
mkdir -p "$BIN_DIR"
CS="$BIN_DIR/chat-send"
if [ -e "$CS" ] && ! grep -qF "$MARK" "$CS" 2>/dev/null; then
    say "leaving the existing $CS alone"
else
    printf '#!/bin/sh\n%s\nexec "%s" "%s" "$@"\n' "$MARK" "$NODE" "$DIR/tools/chat-send.js" > "$CS"
    chmod +x "$CS"
fi

# --- 5. LaunchAgent(s) ----------------------------------------------------
xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$AGENTS" "$HOME/Library/Logs"

write_plist() {   # label script logfile extra-keys
    cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$(xml "$1")</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml "$NODE")</string>
        <string>$(xml "$DIR/$2")</string>
    </array>
    <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DOCK_PORT</key><string>$PORT</string>
        <key>HOME</key><string>$(xml "$HOME")</string>
        <key>PATH</key><string>$(xml "$AGENT_PATH")</string>
    </dict>
    <key>StandardOutPath</key><string>$(xml "$3")</string>
    <key>StandardErrorPath</key><string>$(xml "$3")</string>
$4
</dict>
</plist>
EOF
}

DOMAIN="gui/$UID_N"
stop_job() {
    launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
        launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || break
        sleep 0.5
    done
}
start_job() {
    launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist" 2>/dev/null || { sleep 2; launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"; }
}

stop_job "$LABEL"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
done
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 &&
    die "port $PORT is already in use by another program. Pick another with DOCK_PORT=<port>."

write_plist "$LABEL" server.js "$LOG" "    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>"
start_job "$LABEL"

stop_job "$ULABEL"
if [ "${MOONSTONE_AUTOUPDATE:-0}" = "1" ]; then
    write_plist "$ULABEL" updater.js "$ULOG" "    <key>StartInterval</key><integer>300</integer>"
    start_job "$ULABEL"
    say "auto-update on: updater.js runs every 5 minutes ($ULABEL)"
else
    rm -f "$AGENTS/$ULABEL.plist"
fi

say "waiting for the server on port $PORT"
up=0
for _ in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then up=1; break; fi
    sleep 1
done

echo
if [ "$up" = 1 ]; then
    say "done. Open http://localhost:$PORT  (LaunchAgent $LABEL, log $LOG)"
else
    say "installed, but the server did not answer yet. Check $LOG"
fi
cat <<EOF
[moonstone] Needs Claude Code installed (claude in ~/.local/bin or on PATH) for chats to start.
[moonstone] Edit $DIR/config.json for launchers and peers; config.example.json shows every option.
[moonstone] Uninstall: curl -fsSL https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/uninstall.sh | bash
[moonstone]   (add  -s -- --purge  to also delete $DIR with its config and state)
EOF
[ "$up" = 1 ]
