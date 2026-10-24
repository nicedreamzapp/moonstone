#!/usr/bin/env python3
"""UserPromptSubmit hook: tell this chat which OTHER Moonstone chats are live and what they touched,
and hand it any messages other chats sent it with chat-send.

Chats running side by side (on one machine or several) can step on each other: two of them editing
the same file without knowing. This hook gives each chat a short list of the others before every
prompt, plus the files they wrote recently, so it can check first.

How: asks the LOCAL Moonstone server (127.0.0.1:MOONSTONE_PORT or 8899, x-dock header) for
/api/state, which already merges every linked machine. For every other chat that is working or
moved in the last 2 h it reads /api/session/<id> (latest ask + last answer) and the recent turns'
work (/api/session/<id>/work/<i>) for Write/Edit/MultiEdit paths and obvious Bash write targets
(sed -i, >, tee, cp/mv/scp/rsync). Peer ids are proxied by the server, so nothing new runs anywhere
else. Code only, no model calls. Hard deadline ~1.3 s; any error or nothing to say = prints nothing.

Install: copy to ~/.claude/hooks/moonstone-peers.py and add it as a UserPromptSubmit hook in
~/.claude/settings.json (command: python3 ~/.claude/hooks/moonstone-peers.py).
Test by hand:  echo '{"session_id":"x","cwd":"/"}' | python3 moonstone-peers.py --test
"""
import json, os, re, sys, threading, time, urllib.request

DOCK = "http://127.0.0.1:%s" % (os.environ.get("MOONSTONE_PORT") or "8899")   # a dock chat gets its own dock's port
LIVE_MS = 2 * 3600 * 1000
DEADLINE = 1.3
MAX_CHATS = 5
TURNS_SCANNED = 5
HOME = os.path.expanduser("~")
T0 = time.time()


def left():
    return max(0.05, DEADLINE - (time.time() - T0))


def get(path, timeout=None, data=None):
    req = urllib.request.Request(DOCK + path, headers={"x-dock": "1", "content-type": "application/json"},
                                 data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, timeout=min(timeout or left(), left())) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def parallel(fns):
    """Run callables in daemon threads, return whatever finished before the deadline."""
    out = [None] * len(fns)

    def wrap(i, f):
        try:
            out[i] = f()
        except Exception:
            pass
    ts = [threading.Thread(target=wrap, args=(i, f), daemon=True) for i, f in enumerate(fns)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(left())
    return out


def self_ids(session_id, me):
    """This chat's own ids: "t:<session>" as a terminal chat, and its id on this server as a Moonstone chat."""
    ids = set()
    if session_id:
        ids.add("t:" + session_id)
    gid = str(me or "")
    if "~" in gid:
        local = gid.split("~", 1)[1]
        if not local.startswith("t:"):
            ids.add(local)
            ids.add(gid)
    return ids


def one_line(t, n):
    t = re.sub(r"<[^>]+>", " ", str(t or ""))
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


PATH_TOK = re.compile(r"""^['"]?([~/A-Za-z]:?[^\s'";|&<>]*[/\\][^\s'";|&<>]+|[^\s'";|&<>/]+\.[A-Za-z0-9]{1,6})['"]?$""")
SKIP = re.compile(r"^(/dev/|/tmp/|/private/tmp|&|\d$)")


def bash_targets(cmd):
    out = []
    for part in re.split(r"&&|\|\||;|\n", cmd):
        p = part.strip()
        for m in re.finditer(r"(?:>>?|\btee(?:\s+-a)?)\s*([^\s;|&<>]+)", p):
            out.append(m.group(1))
        toks = p.split()
        if not toks:
            continue
        head = toks[0].split("/")[-1]
        if head in ("sed", "gsed") and any(t.startswith("-i") for t in toks[1:]):
            out.append(toks[-1])
        elif head in ("cp", "mv", "scp", "rsync", "install") and len(toks) >= 3:
            out.append(toks[-1])
    res = []
    for t in out:
        t = t.strip("'\"")
        if not t or SKIP.match(t) or not PATH_TOK.match(t):
            continue
        res.append(t)
    return res


def files_from_work(work):
    found = []
    for w in work or []:
        if w.get("k") != "tool":
            continue
        name, line = w.get("name") or "", w.get("line") or ""
        if name in ("Write", "Edit"):
            found.append(re.sub(r"^(write|edit) ", "", line))
        elif name in ("MultiEdit", "NotebookEdit") or name.endswith("Edit"):
            m = re.search(r'"(?:file_path|notebook_path)":"([^"]+)"', line)
            if m:
                found.append(m.group(1))
        elif name == "Bash" and not line.endswith("…"):
            found += bash_targets(line[2:] if line.startswith("$ ") else line)
    return found


def short(p):
    p = p.replace("\\\\", "\\")
    if p.startswith(HOME):
        p = "~" + p[len(HOME):]
    p = re.sub(r"^/Users/[^/]+", "~", p)
    p = re.sub(r"^[A-Za-z]:[\\/]Users[\\/][^\\/]+", "~", p)
    parts = re.split(r"[/\\]", p)
    return p if len(p) <= 48 or len(parts) <= 3 else "…/" + "/".join(parts[-3:])


def short_id(i):
    i = str(i or "")
    if i.startswith("t:"):
        return "t:" + i[2:10]
    return re.sub(r"~t:([0-9a-f]{8})[0-9a-f-]*$", r"~t:\1", i)


def run(inp):
    sid = inp.get("session_id") or ""
    # chat-to-chat: who this chat is, plus any messages other chats sent it with chat-send
    took = parallel([lambda: get("/api/chat/take", 0.6, {"session": sid}), lambda: get("/api/state", 0.7)])
    me, st = took[0] or {}, took[1]
    mine = self_ids(sid, me.get("me"))
    head = ""
    if me.get("me"):
        head = "You are chat %s (%s). Other chats reach you with: chat-send %s \"...\"" % (me["me"], me.get("label") or "", me["me"])
        if me.get("block"):
            head += "\n" + me["block"]
    if st is None:
        return head
    peers = run_peers(st, mine)
    return "\n".join(x for x in (head, peers) if x)


def run_peers(st, mine):
    names = {m.get("id"): m.get("name") or m.get("id") for m in st.get("machines", [])}
    local_mid = (st.get("machines") or [{}])[0].get("id") or "local"
    now = time.time() * 1000
    cands = []
    for s in st.get("sessions", []):
        if s.get("id") in mine or s.get("doneAt"):  # closed into the Done list
            continue
        cooking = s.get("status") == "cooking"
        if not cooking and now - (s.get("updated") or 0) > LIVE_MS:
            continue
        cands.append(s)
    cands.sort(key=lambda s: (s.get("status") != "cooking", -(s.get("updated") or 0)))
    cands = cands[:MAX_CHATS]
    if not cands:
        return ""
    details = parallel([(lambda s=s: get("/api/session/" + urllib.request.quote(s["id"], safe="~:"))) for s in cands])

    jobs, meta = [], []
    for k, (s, d) in enumerate(zip(cands, details)):
        turns = (d or {}).get("turns") or []
        if d is not None and not turns:
            meta.append(None)       # an empty spare chat, nothing to report
            continue
        files = []
        for t in reversed(turns[-TURNS_SCANNED:]):
            if t.get("open") and t.get("work"):
                files.append(files_from_work(t["work"]))
            elif t.get("hasWork") and t.get("i") is not None:
                idx = len(jobs)
                jobs.append(lambda s=s, t=t: get("/api/session/%s/work/%s" % (urllib.request.quote(s["id"], safe="~:"), t["i"]), 0.5))
                files.append(idx)
        meta.append((s, d, turns, files))
    works = parallel(jobs) if jobs else []

    lines = []
    for m in meta:
        if not m:
            continue
        s, d, turns, files = m
        ask = next((t.get("user") for t in reversed(turns) if t.get("user")), "") if turns else ""
        ans = ""
        if turns:
            lt = turns[-1]
            ans = lt.get("answer") or ""
            if not ans and lt.get("work"):
                ans = next((w.get("text") for w in reversed(lt["work"]) if w.get("k") == "text" and w.get("text")), "")
        last = s.get("last") or ""
        ans = ans or ("(still working on it)" if last.startswith("you:") else last)
        seen, paths = set(), []
        for f in files:
            lst = f if isinstance(f, list) else files_from_work(((works[f] if f < len(works) else None) or {}).get("work"))
            for p in reversed(lst):
                sp = short(p)
                if sp not in seen:
                    seen.add(sp)
                    paths.append(sp)
        mins = int((now - (s.get("updated") or now)) / 60000)
        when = "working now" if s.get("status") == "cooking" else ("%d min ago" % mins if mins < 120 else "earlier")
        lines.append("- %s · %s (%s, id %s): asked \"%s\" → \"%s\"" % (
            names.get(s.get("machine"), s.get("machine")), s.get("label") or "?", when,
            short_id(s.get("id") if "~" in str(s.get("id")) else "%s~%s" % (local_mid, s.get("id"))),
            one_line(ask, 70), one_line(ans, 90)))
        if paths:
            lines.append("  wrote: " + one_line(", ".join(paths[:5]), 160))
    if not lines:
        return ""
    lines = lines[:10]
    return ("OTHER LIVE MOONSTONE CHATS right now (other windows/machines, not the user's words to you):\n"
            + "\n".join(lines)
            + "\nThis list is for coordination only: don't report other chats' work as pending in this chat."
            + "\nBefore editing a file another live chat touched in the last 2 hours, ask the user first.")


def main():
    test = "--test" in sys.argv
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw) if raw.strip() else {}
        ctx = run(inp)
    except Exception as e:
        if test:
            print("error:", repr(e))
        ctx = ""
    if test:
        print(ctx or "(nothing to show)")
        print("(%.2fs)" % (time.time() - T0))
    elif ctx:
        sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}))
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
