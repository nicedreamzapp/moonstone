#!/usr/bin/env python3
"""Claude plan usage (the numbers /usage shows): 5-hour and weekly percent + reset times, as JSON.
Reads Claude Code's own login from the macOS keychain; the token is never printed. Added 2026-10-05
for the Moonstone usage bar."""
import json, os, subprocess, sys, urllib.request
def token():
    # keychain first (a GUI-session job can read it), then the file Claude Code keeps when there is no keychain
    raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                         capture_output=True, text=True).stdout.strip()
    for src in (lambda: raw, lambda: open(os.path.expanduser("~/.claude/.credentials.json")).read()):
        try: return json.loads(src())["claudeAiOauth"]["accessToken"]
        except Exception: pass
    print(json.dumps({"error": "no Claude Code login found"})); sys.exit(1)
tok = token()
req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
      headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code"})
try:
    print(urllib.request.urlopen(req, timeout=10).read().decode())
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(1)
