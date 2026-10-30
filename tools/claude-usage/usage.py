#!/usr/bin/env python3
"""Claude plan usage (the numbers /usage shows): 5-hour and weekly percent + reset times, as JSON.
Reads Claude Code's own login from the macOS keychain; the token is never printed. Added 2026-10-05
for the Moonstone usage bar. 10/30: when Anthropic answers 429 the wait (Retry-After, at least 15 min) is
written to usage-wait.json beside this script and no call is made until it passes, so old docks that still
ask every minute can't keep the block going; a good reading is cached 3 minutes the same way."""
import json, os, subprocess, sys, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
WAIT, CACHE = os.path.join(HERE, "usage-wait.json"), os.path.join(HERE, "usage-last.json")
def rd(f):
    try: return json.load(open(f))
    except Exception: return {}
w = rd(WAIT)
c = rd(CACHE)
if c.get("body") and time.time() - c.get("t", 0) < 180:
    print(c["body"]); sys.exit(0)
if time.time() < w.get("until", 0):
    print(json.dumps({"error": "HTTP Error 429: waiting until %s" % time.strftime("%H:%M", time.localtime(w["until"]))})); sys.exit(1)
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
    body = urllib.request.urlopen(req, timeout=10).read().decode()
    json.dump({"t": time.time(), "body": body}, open(CACHE, "w")); print(body)
except urllib.error.HTTPError as e:
    if e.code == 429:
        json.dump({"until": time.time() + max(int(e.headers.get("Retry-After") or 0), 900)}, open(WAIT, "w"))
        print(json.dumps({"error": str(e)})); sys.exit(1)
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(1)
