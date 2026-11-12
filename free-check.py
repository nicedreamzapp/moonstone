#!/usr/bin/env python3
"""Free cloud model check.

    python3 free-check.py <dock folder> [--force]

Run it every 6 hours (cron, launchd or the Task Scheduler). Code first:
 1. cheap check, no model call: is the key there, and does the provider's /models list still have the model?
 2. a real tool call, through the local free-model bridge (FREEBRIDGE_PORT, default 8791), ONLY when something changed since the last good probe
    (key changed, the model appeared/vanished, the last probe failed) or the last good probe is 7+ days old.
Writes <dock>/free-check.json, which the Auto picker reads: a free model whose last tool call failed is never picked.
Keys are read from the keys file and sent as headers only; nothing secret is printed or put on a command line.
"""
import hashlib, json, os, re, sys, threading, time, urllib.request, urllib.error

WIN = os.name == "nt"
HOME = os.path.expanduser("~")
DOCK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else os.path.dirname(os.path.abspath(__file__)))
FORCE = "--force" in sys.argv
OUT, STATE_F = os.path.join(DOCK, "free-check.json"), os.path.join(DOCK, "free-check.state.json")
KEYS_F = os.environ.get("MOONSTONE_KEYS_FILE") or os.path.join(HOME, ".config", "free-api", "keys.env")   # same file as config auto.keysFile
DAY, WEEK = 6 * 3600, 6 * 3600     # every run re-times every model

# id -> (freebridge provider, key name, models to try in order: the first one the provider lists is used)
# ids match auto-rules.json; "extra" ones are checked and reported but have no Moonstone button yet.
CANDIDATES = {
    "nemotron-vl": ("openrouter", "OPENROUTER_API_KEY", ["nvidia/nemotron-3.5-super-vl:free"]),
    "gemini": ("gemini", "GEMINI_API_KEY", ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
                                             "gemini-flash-latest", "gemini-3.1-flash-lite"]),
    "openrouter": ("openrouter", "OPENROUTER_API_KEY", ["@scout"]),   # filled by scout() with the fastest free vision+tools model
    "kimi-nvidia": ("nvidia", "NVIDIA_API_KEY", ["moonshotai/kimi-k2.6"]),
    "deepseek-nvidia": ("nvidia", "NVIDIA_API_KEY", ["deepseek-ai/deepseek-v4.1-flash"]),
    "glm-nvidia": ("nvidia", "NVIDIA_API_KEY", ["z-ai/glm-5.3"]),
    "groq": ("groq", "GROQ_API_KEY", ["moonshotai/kimi-k2-instruct-0905", "openai/gpt-oss-120b", "qwen/qwen3-32b",
                                       "llama-3.3-70b-versatile"]),
    "cerebras": ("cerebras", "CEREBRAS_API_KEY", ["zai-glm-4.7", "gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507",
                                                   "llama-3.3-70b"]),
    "cloudflare": ("cloudflare", "CLOUDFLARE_API_TOKEN", ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]),
}
LIST_URL = {"nvidia": "https://integrate.api.nvidia.com/v1/models", "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/models",
            "openrouter": "https://openrouter.ai/api/v1/models", "groq": "https://api.groq.com/openai/v1/models",
            "cerebras": "https://api.cerebras.ai/v1/models"}
TOOL = {"name": "get_order_status", "description": "Look up a shop order's status by its number.",
        "input_schema": {"type": "object", "properties": {"order": {"type": "string"}}, "required": ["order"]}}
ASK = "What is the status of order 1001? Use the tool to look it up."


def keys():
    try:
        return dict(re.findall(r'^(?:export\s+)?(\w+)=["\']?([^"\'\r\n]+)', open(KEYS_F, encoding="utf-8-sig").read(), re.M))
    except OSError:
        return {}


def load(f, d):
    try:
        return json.load(open(f))
    except Exception:
        return d


def get(url, key, timeout=20):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "User-Agent": "moonstone-free-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def listed(provider, key):
    """set of model ids the provider offers right now, or None when it can't be read (no model call)."""
    if provider not in LIST_URL:
        return None
    try:
        d = get(LIST_URL[provider], key)
        return {re.sub(r"^models/", "", m.get("id", "")) for m in d.get("data") or []}
    except urllib.error.HTTPError as e:
        return "HTTP %d" % e.code
    except Exception as e:
        return "unreachable (%s)" % type(e).__name__


def bridge_port(K):
    return int(K.get("FREEBRIDGE_PORT") or 8791)


def probe(port, provider, model):
    """one real tool call through freebridge, the same path a Moonstone chat uses -> (ok, secs, why)"""
    body = {"model": model, "max_tokens": 2048, "messages": [{"role": "user", "content": ASK}], "tools": [TOOL]}
    req = urllib.request.Request("http://127.0.0.1:%d/%s/v1/messages" % (port, provider), data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-api-key": "bridge"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            m = json.load(r)
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            txt = json.loads(txt)["error"]["message"]
        except Exception:
            pass
        return False, round(time.time() - t, 1), "HTTP %d %s" % (e.code, re.sub(r"\s+", " ", str(txt))[:140])
    except Exception as e:
        return False, round(time.time() - t, 1), "no answer (%s)" % type(e).__name__
    secs = round(time.time() - t, 1)
    calls = [b for b in m.get("content") or [] if b.get("type") == "tool_use"]
    if not calls:
        return False, secs, "answered without calling the tool"
    c = calls[0]
    if c.get("name") != TOOL["name"] or "1001" not in json.dumps(c.get("input")):
        return False, secs, "malformed tool call: %s %s" % (c.get("name"), json.dumps(c.get("input"))[:80])
    return True, secs, ""


def scout(key, skip):
    """every free OpenRouter model that reads images and
    calls tools, newest first, max 8 -> their ids. The fastest one that passes the real tool call takes the "openrouter" slot."""
    try:
        d = get(LIST_URL["openrouter"], key)
    except Exception:
        return []
    ms = [m for m in d.get("data") or [] if m.get("id", "").endswith(":free") and m.get("id") not in skip
          and "image" in ((m.get("architecture") or {}).get("input_modalities") or []) and "tools" in (m.get("supported_parameters") or [])]
    return [m["id"] for m in sorted(ms, key=lambda m: -(m.get("created") or 0))[:8]]


def main():
    K, st, prev = keys(), load(STATE_F, {}), load(OUT, {}).get("models", {})
    now = time.time()
    if not FORCE and now - st.get("at", 0) < DAY:
        return
    port, out, todo, lists = bridge_port(K), {}, [], {}
    for mid, (prov, kname, models) in CANDIDATES.items():
        key = K.get(kname, "")
        if not key:
            out[mid] = {"provider": prov, "ok": False, "why": "no key on this machine", "checked": int(now)}
            continue
        if prov not in lists:
            lists[prov] = listed(prov, key)
        have = lists[prov]
        if isinstance(have, str):   # the list call itself failed: a dead key looks like 401/403 here
            out[mid] = {"provider": prov, "ok": False, "why": "model list " + have + (" (dead key?)" if have in ("HTTP 401", "HTTP 403") else ""),
                        "checked": int(now)}
            continue
        if models == ["@scout"]:
            todo.append((mid, prov, scout(key, {m for c in CANDIDATES.values() for m in c[2]}), "scout"))
            continue
        offered = [m for m in models if have is None or m in have]
        model = offered[0] if offered else None
        if not model:
            out[mid] = {"provider": prov, "ok": False, "why": "none of its models is offered any more", "checked": int(now)}
            continue
        fp = hashlib.sha256((kname + key + model).encode()).hexdigest()[:16]
        p = prev.get(mid) or {}
        fresh = p.get("ok") and p.get("fp") == fp and now - p.get("probed", 0) < WEEK
        if fresh and not FORCE:
            out[mid] = {**p, "checked": int(now)}
        else:
            todo.append((mid, prov, offered, fp))
    lock = threading.Lock()

    def run(mid, prov, offered, fp):
        if fp == "scout":   # time every candidate; the fastest working one wins the slot
            best = None
            for model in offered:
                ok, secs, why = probe(port, prov, model)
                if ok and (best is None or secs < best[1]):
                    best = (model, secs)
            with lock:
                out[mid] = ({"provider": prov, "model": best[0], "ok": True, "secs": best[1], "why": "", "fp": "scout", "probed": int(time.time()), "checked": int(now)}
                            if best else {"provider": prov, "ok": False, "why": "no free vision+tools model passed (%d tried)" % len(offered), "checked": int(now)})
            return
        ok, secs, why, model = False, 0, "no model", None
        for model in offered[:3]:   # busy or out of quota (Gemini Flash 503s at peak): its next model
            ok, secs, why = probe(port, prov, model)
            if ok or not re.match(r"HTTP (429|503|404)", why):
                break
        with lock:
            out[mid] = {"provider": prov, "model": model, "ok": ok, "secs": secs, "why": why, "fp": fp,
                        "probed": int(time.time()), "checked": int(now)}
    th = [threading.Thread(target=run, args=t) for t in todo]
    for t in th:
        t.start()
    for t in th:
        t.join(330)
    res = {"at": int(now), "note": "written by free-check.py: last real tool call per free model (ok/secs/why)", "models": out}
    json.dump(res, open(OUT + ".tmp", "w"), indent=1)
    os.replace(OUT + ".tmp", OUT)
    json.dump({"at": int(now)}, open(STATE_F, "w"))
    changed = [m for m in out if bool(out[m].get("ok")) != bool((prev.get(m) or {}).get("ok"))]
    if changed or FORCE:
        print("; ".join("%s %s" % (m, ("ok %ss" % out[m].get("secs")) if out[m].get("ok") else "OUT: " + out[m].get("why", ""))
                        for m in sorted(out)))


if __name__ == "__main__":
    main()
