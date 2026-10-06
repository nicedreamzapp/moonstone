#!/usr/bin/env node
// Moonstone — one browser window for every Claude Code conversation on this machine (and its peers).
//
// Two kinds of sessions show up:
//   dock      started from Moonstone; a headless `claude -p` stream-json process Moonstone owns,
//             so it can type into it, answer permission prompts, and stop it.
//   terminal  a Claude Code session running in a terminal right now; shown with its transcript,
//             and typing into it moves the conversation into Moonstone.
// Both are read from the transcript .jsonl files, so a conversation looks the same either way.
//
// Binds 127.0.0.1 only. Every POST needs the X-Dock header (a cross-site page can't send it
// without a CORS preflight, which we never grant) and the Host header must be local (DNS rebinding).

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");

const PORT = +process.env.DOCK_PORT || 8899;
const HOME = os.homedir();
const PROJECTS = path.join(HOME, ".claude", "projects");
// Where to find the claude binary. config.json "claude" overrides; otherwise the usual install locations.
const WIN = process.platform === "win32";
const CLAUDE_CANDIDATES = WIN
  ? [path.join(HOME, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA || "", "npm", "claude.cmd")]
  : [path.join(HOME, ".local", "bin", "claude"), path.join(HOME, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
// config.json: {"machine":"m1","name":"M1","peers":[{"id":"m2","name":"M2","url":"http://127.0.0.1:18899"}]}
let CONFIG = { machine: "local", name: "This Mac", peers: [], remoteOrigins: [] };
try { CONFIG = { ...CONFIG, ...JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")) }; } catch {}
const CLAUDE = CONFIG.claude || CLAUDE_CANDIDATES.find(p => { try { fs.accessSync(p, WIN ? fs.constants.F_OK : fs.constants.X_OK); return true; } catch { return false; } });
const STATE_FILE = path.join(__dirname, "state.json");
const LAUNCHER_DIRS = [path.join(HOME, "Desktop", "Launchers"), path.join(HOME, "Desktop")];
const RECENT_MS = 12 * 3600e3;
const LIVE_MS = 90e3;

// ---------- launchers: from config.json, or discovered from Ghostty launcher apps ----------
const COLORS = ["#8b7bff", "#ffb35c", "#3fd1c0", "#5aa2ff", "#ff6fae", "#2ec4a6", "#a98bff", "#f2b347", "#7cc8ff"];
function loadLaunchers() {
  // config.json can list launchers directly. That is the normal setup, and the only one that works
  // under launchd, which can't read ~/Desktop without a privacy prompt nobody is around to click.
  // kind: "claude" (a Claude Code chat), "pipe" (a local-model chat driven over stdin/stdout),
  // "open" (just opens that app on this machine). group: main | cloud | local | tasks.
  const tilde = v => (v ? String(v).replace(/^~/, HOME) : v);
  if (CONFIG.launchers) return CONFIG.launchers.map((l, i) => ({ id: l.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), mode: "default", kind: "claude", group: "cloud", color: COLORS[i % COLORS.length], ...l, cwd: tilde(l.cwd) || HOME, cmd: tilde(l.cmd), path: tilde(l.path) }));
  // (api launchers keep url / serve / system from config as-is)
  const out = [];
  for (const dir of LAUNCHER_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith(".app")); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n, "Contents", "Resources", "launch.ghostty");
      let t; try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
      if (!/\bclaude\b/.test(t)) continue;
      const label = (t.match(/CLAUDE_SESSION_LABEL='([^']+)'/) || [])[1] || n.replace(/\.app$/, "");
      let cwd = (t.match(/cd '([^']+)'/) || t.match(/cd (~[^ &;]+)/) || [])[1] || HOME;
      cwd = cwd.replace(/^~/, HOME);
      const mode = (t.match(/--permission-mode (\w+)/) || [])[1] || "default";
      if (out.some(o => o.label === label)) continue;
      out.push({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label, cwd, mode });
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  out.forEach((o, i) => (o.color = COLORS[i % COLORS.length]));
  return out;
}
let launchers = loadLaunchers();

// ---------- transcript parsing (incremental) ----------
const files = new Map(); // path -> {offset, buf, model}
function newModel() { return { turns: [], toolIndex: {}, cwd: null, title: null, lastPrompt: null, sessionId: null }; }

function cleanUserText(t) {
  if (typeof t !== "string") return "";
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, "$1");
  if (/^\s*<(command-|local-command|bash-|task-notification|user-prompt-submit)/.test(t)) return "";
  return t.trim();
}
function summarizeTool(name, input = {}) {
  const s = v => String(v ?? "").replace(HOME, "~");
  switch (name) {
    case "Bash": return "$ " + s(input.command);
    case "Read": return "read " + s(input.file_path);
    case "Write": return "write " + s(input.file_path);
    case "Edit": return "edit " + s(input.file_path);
    case "Grep": return "search “" + s(input.pattern) + "”" + (input.path ? " in " + s(input.path) : "");
    case "Glob": return "find " + s(input.pattern);
    case "WebFetch": return "fetch " + s(input.url);
    case "WebSearch": return "search the web: " + s(input.query);
    case "Agent": case "Task": return "agent: " + s(input.description || input.prompt).slice(0, 120);
    default: {
      const j = JSON.stringify(input); return name.replace(/^mcp__[^_]+__/, "") + " " + (j.length > 160 ? j.slice(0, 160) + "…" : j);
    }
  }
}
function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => (x.type === "text" ? x.text : x.type === "image" ? "[image]" : "")).join("\n");
  return "";
}
function apply(m, d) {
  if (d.cwd && !m.cwd) m.cwd = d.cwd;
  if (d.sessionId && !m.sessionId) m.sessionId = d.sessionId;
  if (d.type === "ai-title") { m.title = d.aiTitle; return; }
  if (d.type === "last-prompt") { m.lastPrompt = d.lastPrompt; return; }
  if (d.isSidechain) return;
  const msg = d.message; if (!msg) return;
  const ts = d.timestamp ? Date.parse(d.timestamp) : null;
  if (d.type === "user" && !d.isMeta) {
    const c = msg.content;
    if (typeof c === "string") {
      const t = cleanUserText(c); if (t) m.turns.push({ user: t, ts, steps: [], done: false });
      return;
    }
    if (!Array.isArray(c)) return;
    let texts = [];
    for (const b of c) {
      if (b.type === "tool_result") {
        const step = m.toolIndex[b.tool_use_id];
        if (step) { const r = resultText(b.content); step.out = r.length > 3000 ? r.slice(0, 3000) + "\n…" : r; step.err = !!b.is_error; }
      } else if (b.type === "text") texts.push(b.text);
      else if (b.type === "image") texts.push("[image]");
    }
    const t = cleanUserText(texts.join("\n"));
    if (t) m.turns.push({ user: t, ts, steps: [], done: false });
  } else if (d.type === "assistant") {
    let turn = m.turns[m.turns.length - 1];
    if (!turn) { turn = { user: null, ts, steps: [], done: false }; m.turns.push(turn); }
    for (const b of msg.content || []) {
      if (b.type === "text" && b.text.trim()) turn.steps.push({ k: "text", text: b.text });
      else if (b.type === "tool_use") {
        const step = { k: "tool", name: b.name, line: summarizeTool(b.name, b.input), out: null };
        m.toolIndex[b.id] = step; turn.steps.push(step);
      }
    }
    turn.end = ts;
  }
}
function readFileModel(p) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  let f = files.get(p);
  if (!f || st.size < f.offset) { f = { offset: 0, rest: "", model: newModel() }; files.set(p, f); }
  if (st.size > f.offset) {
    const fd = fs.openSync(p, "r");
    const len = st.size - f.offset; const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, f.offset); fs.closeSync(fd);
    f.offset = st.size;
    const text = f.rest + buf.toString("utf8");
    const lines = text.split("\n"); f.rest = lines.pop();
    for (const l of lines) { if (!l) continue; try { apply(f.model, JSON.parse(l)); } catch {} }
  }
  f.mtime = st.mtimeMs;
  return f;
}
// A turn's answer is its last text step once it is finished; everything else is "the work".
function shapeTurns(model, liveTurnOpen) {
  return model.turns.map((t, i) => {
    const last = i === model.turns.length - 1;
    const open = last && liveTurnOpen;
    let answer = null, work = t.steps;
    if (!open) {
      const idx = t.steps.map(s => s.k).lastIndexOf("text");
      if (idx >= 0) { answer = t.steps[idx].text; work = t.steps.filter((_, j) => j !== idx); }
    }
    const secs = t.end && t.ts ? Math.max(0, Math.round((t.end - t.ts) / 1000)) : null;
    return { i, user: t.user, answer, work, open, secs };
  });
}
const KEEP_TURNS = 40;
function lean(turns) {
  return turns.slice(-KEEP_TURNS).map(t => t.open ? t
    : { ...t, work: null, workN: t.work.filter(w => w.k === "tool").length, hasWork: t.work.length > 0 });
}

// ---------- closing the terminal a session came from ----------
// When a terminal session is taken over, its window should go away, not sit there stale.
// Chain is claude <- shell <- terminal. A terminal app that runs one process per window (listed in
// config "oneWindowTerminals") is closed too; a shared terminal app (Ghostty, Terminal) only loses that shell's tab.
function procInfo(pid) {
  return new Promise(res => {
    if (WIN) {
      execFile("powershell", ["-NoProfile", "-Command", `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${+pid}"; if($p){"$($p.ParentProcessId)|$($p.Name)"}`], { timeout: 8000, windowsHide: true },
        (e, out) => { const [pp, name] = String(out || "").trim().split("|"); res(pp ? { ppid: +pp, name: name || "" } : null); });
    } else execFile("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { timeout: 3000 }, (e, out) => {
      const m = String(out || "").trim().match(/^(\d+)\s+(.*)$/); res(m ? { ppid: +m[1], name: m[2] } : null);
    });
  });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SHELLS = /(^|[\/-])(zsh|bash|sh|fish|pwsh|powershell|cmd)(\.exe)?$/i;
async function stopTerminalSession(pid) {
  const me = await procInfo(pid); const shell = me && me.ppid > 1 ? await procInfo(me.ppid) : null;
  const shellPid = me?.ppid, termPid = shell?.ppid;
  const shellOk = shell && SHELLS.test(String((await procInfo(shellPid))?.name || ""));
  const term = termPid > 1 ? await procInfo(termPid) : null;
  const termName = term ? String((await procInfo(termPid))?.name || "") : "";
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
  if (!shellOk) return;
  if (WIN) { execFile("taskkill", ["/PID", String(shellPid), "/T", "/F"], { windowsHide: true }, () => {}); }
  else { try { process.kill(shellPid, "SIGHUP"); } catch {} }
  await new Promise(r => setTimeout(r, 800));
  const oneWindow = (CONFIG.oneWindowTerminals || []).some(n => termName.toLowerCase().includes(String(n).toLowerCase()));
  if (oneWindow && alive(termPid)) { try { process.kill(termPid, "SIGTERM"); } catch {} }
}

// ---------- dock-owned sessions ----------
let state = { sessions: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ sessions: state.sessions.map(({ id, sessionId, cwd, label, mode, color, created, hidden, kind, cmd, log, launcher }) => ({ id, sessionId, cwd, label, mode, color, created, hidden, kind, cmd, log, launcher })) }, null, 2));
const procs = new Map(); // dock id -> {child, busy, perm, unread, err}

const tpCache = new Map();
function findTranscriptCached(sid) {
  if (!sid || sid === "null") return null;
  let p = tpCache.get(sid); if (p && fs.existsSync(p)) return p;
  p = findTranscript(sid); if (p) tpCache.set(sid, p); return p;
}
function findTranscript(sessionId) {
  if (!sessionId) return null;
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, d, sessionId + ".jsonl");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function startProc(s) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-hook-events", "--permission-prompt-tool", "stdio", "--permission-mode", s.mode || "default"];
  if (s.sessionId) args.push("--resume", s.sessionId);
  const env = { ...process.env, CLAUDE_SESSION_LABEL: s.label };
  if (!WIN) env.PATH = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const child = spawn(CLAUDE, args, { cwd: s.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: WIN && /\.cmd$/i.test(CLAUDE) });
  const p = { child, busy: false, perm: null, unread: false, err: null, lastLine: "" };
  procs.set(s.id, p);
  let buf = "";
  child.stdout.on("data", chunk => {
    buf += chunk; const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; let d; try { d = JSON.parse(l); } catch { continue; } onEvent(s, p, d); }
  });
  child.stderr.on("data", c => { p.lastLine = String(c).trim().slice(-300); });
  child.on("error", e => { p.err = "couldn't start claude: " + e.message; p.busy = false; deadErr.set(s.id, p.err); console.error(p.err); broadcast(); });
  child.on("exit", code => {
    if (procs.get(s.id) === p) procs.delete(s.id);
    if (p.busy && code) p.err = p.lastLine || `stopped (exit ${code})`;
    if (p.err) { const e = { ...p, child: null }; deadErr.set(s.id, e.err); }
    broadcast();
  });
  return p;
}
const deadErr = new Map();

function onEvent(s, p, d) {
  if (d.type === "system" && d.subtype === "init" && d.session_id && s.sessionId !== d.session_id) {
    s.sessionId = d.session_id; if (!s.spare) saveState();
  } else if (d.type === "control_request" && d.request?.subtype === "can_use_tool") {
    const r = d.request;
    p.perm = { request_id: d.request_id, tool: r.tool_name, line: summarizeTool(r.tool_name, r.input), input: r.input,
      question: r.tool_name === "AskUserQuestion" ? r.input : null };
  } else if (d.type === "system" && d.subtype === "hook_started" && d.hook_event === "Stop") {
    // the model is done; Stop hooks can take a long time (a sync script, say), so don't keep the session "busy" for them
    p.busy = false; p.perm = null; p.unread = true;
  } else if (d.type === "result") {
    p.busy = false; p.perm = null; p.unread = true;
    if (d.is_error && d.result) p.err = String(d.result).slice(0, 300);
  }
  broadcast(s.id);
}
// Warm spares: a claude process per launcher, started ahead of time, so a new session skips the
// startup wait (it can take a minute when many MCP servers load). Taken on launch and refilled.
const spares = new Map(); // launcher id -> session object with a running proc
function fillSpares() {
  for (const l of launchers) {
    if ((l.kind || "claude") !== "claude") continue;
    if (CONFIG.warm && !CONFIG.warm.includes(l.label)) continue;
    const have = spares.get(l.id);
    if (have && procs.get(have.id)?.child.exitCode === null) continue;
    const s = { id: crypto.randomUUID().slice(0, 8), sessionId: null, cwd: l.cwd, label: l.label, mode: l.mode, color: l.color, created: Date.now(), spare: true };
    startProc(s); spares.set(l.id, s);
  }
}
function takeSpare(l) {
  const s = spares.get(l.id); spares.delete(l.id);
  if (!s || procs.get(s.id)?.child.exitCode !== null) return null;
  delete s.spare; s.created = Date.now(); return s;
}
setTimeout(fillSpares, 3000);
setInterval(fillSpares, 60000);
// ---------- local-model chats ("pipe" sessions) ----------
// A "pipe" launcher runs a script that reads one line from stdin and prints "› " when it is ready
// for the next one (a llama.cpp or MLX chat loop, for example). TERM=dumb asks it to skip colors and spinners.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;
function startPipe(s) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", TERM: "dumb", CLAUDE_SESSION_LABEL: s.label };
  if (!WIN) env.PATH = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const child = spawn("/bin/bash", [s.cmd], { cwd: s.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const p = { child, busy: true, perm: null, unread: false, err: null, pipe: true, out: "" };
  procs.set(s.id, p);
  s.log = s.log || [];
  if (!s.log.length) s.log.push({ user: null, answer: "", ts: Date.now() }); // the loading banner
  const onOut = chunk => {
    p.out += String(chunk).replace(ANSI, "");
    const turn = s.log[s.log.length - 1];
    const ready = /(^|\n)\s*›\s*$/.test(p.out);
    turn.answer = p.out.replace(/(^|\n)\s*›\s*$/, "").replace(/^\s+|\s+$/g, "").slice(-20000);
    if (ready) { p.busy = false; p.unread = true; p.out = ""; turn.end = Date.now(); saveState(); }
    broadcast(s.id);
  };
  child.stdout.on("data", onOut); child.stderr.on("data", onOut);
  child.on("error", e => { p.err = "couldn't start: " + e.message; p.busy = false; deadErr.set(s.id, p.err); broadcast(); });
  child.on("exit", code => { if (procs.get(s.id) === p) procs.delete(s.id); if (p.busy) deadErr.set(s.id, `stopped (exit ${code})`); saveState(); broadcast(); });
  return p;
}
function sendPipe(s, text) {
  let p = procs.get(s.id);
  if (!p || p.child.exitCode !== null) p = startPipe(s);
  deadErr.delete(s.id);
  s.log.push({ user: text, answer: "", ts: Date.now() });
  if (s.log.length > 60) s.log = s.log.slice(-60);
  p.busy = true; p.unread = false; p.out = "";
  p.child.stdin.write(text.replace(/\n/g, " ") + "\n");
  saveState(); broadcast(s.id);
}
function killTree(p, sig = "SIGTERM") { try { process.kill(-p.child.pid, sig); } catch { try { p.child.kill(sig); } catch {} } }
// a local model can hold tens of GB of memory, so an idle one is closed after 30 minutes
setInterval(() => {
  for (const s of state.sessions) {
    const p = procs.get(s.id); if (!p?.pipe || p.busy) continue;
    const last = s.log?.[s.log.length - 1]; const at = last?.end || last?.ts || 0;
    if (Date.now() - at > 30 * 60e3) { killTree(p); s.log.push({ user: null, answer: "(closed after 30 idle minutes to free its memory; send a message to start it again)", ts: Date.now(), end: Date.now() }); saveState(); }
  }
}, 60e3);

// ---------- model-server chats ("api" sessions) ----------
// Talks to an OpenAI-style server (llama.cpp's llama-server, Ollama, LM Studio...). If the launcher has a
// "serve" command, the dock starts that server on the first message and stops it after 30 idle
// minutes so the RAM comes back.
const servers = new Map(); // launcher id -> { child, lastUsed, ready }
function getJSON(url, timeout = 3000) {
  return new Promise(res => { const r = http.get(url, { timeout }, x => { let b = ""; x.on("data", c => (b += c)); x.on("end", () => res(x.statusCode === 200 ? b : null)); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); });
}
async function ensureServer(l, onNote) {
  const health = l.url + (l.health || "/health");   // Ollama answers on "/" instead
  if (await getJSON(health)) return true;
  if (!l.serve) return false;
  let sv = servers.get(l.id);
  if (!sv || sv.child.exitCode !== null) {
    onNote("Loading the model…");
    const child = spawn(l.serve.cmd, l.serve.args || [], { cwd: path.dirname(l.serve.cmd), stdio: "ignore", windowsHide: true, detached: !WIN });
    sv = { child, lastUsed: Date.now() }; servers.set(l.id, sv);
    child.on("exit", () => { if (servers.get(l.id) === sv) servers.delete(l.id); });
    // a CPU model pegs every core it is given; idle priority keeps the mouse and Brave responsive
    if (WIN && child.pid) spawn("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).PriorityClass = 'Idle'`], { stdio: "ignore", windowsHide: true });
  }
  for (let i = 0; i < 180; i++) { if (await getJSON(health)) return true; await new Promise(r => setTimeout(r, 1000)); if (sv.child.exitCode !== null) return false; }
  return false;
}
async function sendApi(s, text) {
  const l = launchers.find(x => x.id === s.launcher); if (!l) return;
  const p = procs.get(s.id) || { api: true, busy: false, unread: false, err: null, child: { pid: 0, exitCode: null, kill() {} } };
  procs.set(s.id, p); deadErr.delete(s.id);
  s.log = s.log || []; s.log.push({ user: text, answer: "", ts: Date.now() });
  const turn = s.log[s.log.length - 1];
  p.busy = true; p.unread = false; p.liveTok = 0; saveState(); broadcast(s.id);
  const fail = msg => { if (turn.end) return; turn.answer = msg; turn.end = Date.now(); p.busy = false; p.req = null; deadErr.set(s.id, msg); saveState(); broadcast(s.id); };
  if (!(await ensureServer(l, note => { turn.answer = note; broadcast(s.id); }))) return fail("The model server didn't start.");
  turn.answer = "";
  const sv = servers.get(l.id); if (sv) sv.lastUsed = Date.now();
  const messages = [];
  if (l.system) messages.push({ role: "system", content: l.system });
  for (const t of s.log.slice(-20)) { if (t.user) messages.push({ role: "user", content: t.user }); if (t.answer && t !== turn) messages.push({ role: "assistant", content: t.answer }); }
  const u = new URL(l.url + "/v1/chat/completions");
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" } }, res => {
    let buf = "", last = 0;
    res.on("data", c => {
      buf += c; const lines = buf.split("\n"); buf = lines.pop();
      for (const ln of lines) {
        if (!ln.startsWith("data: ")) continue; const d = ln.slice(6).trim(); if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d), x = j.choices?.[0]?.delta || {};
          // thinking arrives as reasoning_content: count it so the token meter moves while nothing is shown yet
          if (x.content || x.reasoning_content || x.reasoning) p.liveTok = (p.liveTok || 0) + 1;
          if (j.usage?.completion_tokens) p.liveTok = j.usage.completion_tokens;
          turn.answer += x.content || "";
        } catch {}
      }
      if (Date.now() - last > 300) { last = Date.now(); broadcast(s.id); }
    });
    res.on("end", () => { if (turn.end) return; turn.answer = turn.answer.replace(/^\s+/, "") || "(no answer)"; turn.tok = p.liveTok || 0; turn.end = Date.now(); p.busy = false; p.req = null; p.unread = true; if (sv) sv.lastUsed = Date.now(); saveState(); broadcast(s.id); });
  });
  p.req = req; p.stop = () => { req.destroy(); fail((turn.answer ? turn.answer + "\n\n" : "") + "(stopped)"); deadErr.delete(s.id); };
  req.setTimeout(180e3, () => { req.destroy(); fail("The model went quiet for 3 minutes, so I stopped it."); });
  req.on("error", e => fail("Lost the model server: " + e.message));
  req.end(JSON.stringify({ ...(l.model ? { model: l.model } : {}), messages, stream: true, temperature: 0.7, stream_options: { include_usage: true } }));
}
setInterval(() => {
  for (const [id, sv] of servers) {
    const busy = state.sessions.some(x => x.launcher === id && procs.get(x.id)?.busy);
    if (!busy && Date.now() - sv.lastUsed > 30 * 60e3) { try { sv.child.kill(); } catch {} servers.delete(id); }
  }
}, 60e3);

function sendLine(p, obj) { p.child.stdin.write(JSON.stringify(obj) + "\n"); }

function send(s, text) {
  if (s.kind === "pipe") return sendPipe(s, text);
  if (s.kind === "api") return void sendApi(s, text);
  let p = procs.get(s.id);
  if (!p || p.child.exitCode !== null) p = startProc(s);
  deadErr.delete(s.id);
  p.busy = true; p.err = null; p.unread = false; p.pendingText = text;
  sendLine(p, { type: "user", message: { role: "user", content: text } });
  broadcast(s.id);
}

// ---------- session list ----------
function machineGpu() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise(res => execFile("/usr/sbin/ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], { timeout: 3000 }, (e, out) => {
    const m = String(out || "").match(/"Device Utilization %"=(\d+)/); res(m ? +m[1] : null);
  }));
}
// memory: what's actually loaded (models sit in RAM even when the GPU reads 0% between answers)
let memCache = null;
function machineMem() {
  const total = os.totalmem();
  if (process.platform !== "darwin") return Promise.resolve({ total, used: total - os.freemem() });
  // Activity Monitor's "Memory Used": app (anonymous) + wired + compressed pages
  return new Promise(res => execFile("/usr/bin/vm_stat", [], { timeout: 4000 }, (e, out) => {
    const t = String(out || ""); const ps = +(t.match(/page size of (\d+)/) || [])[1] || 16384;
    const g = k => +(t.match(new RegExp(k + ":\\s+(\\d+)")) || [])[1] || 0;
    const used = (g("Anonymous pages") - g("Pages purgeable") + g("Pages wired down") + g("Pages occupied by compressor")) * ps;
    res(used > 0 ? { total, used: Math.min(used, total) } : { total, used: total - os.freemem() });
  }));
}
setInterval(async () => { memCache = await machineMem(); }, 5000);
machineMem().then(m => (memCache = m));
let gpuCache = null;
setInterval(async () => { gpuCache = await machineGpu(); }, 5000);
machineGpu().then(g => (gpuCache = g));

function launcherFor(cwd) {
  return launchers.find(l => l.cwd === cwd) || null;
}
function labelFor(cwd) {
  const l = launcherFor(cwd); if (l) return l;
  if (cwd === HOME) return launchers.find(x => x.label === "Claude Code") || { label: "Claude Code", color: "#7cc8ff" };
  return { label: path.basename(cwd || "?"), color: "#7cc8ff" };
}

function liveTerminalSessions() {
  const dir = path.join(HOME, ".claude", "sessions"); const out = [];
  let names = []; try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch {}
  for (const n of names) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
    if (j.entrypoint && j.entrypoint !== "cli") continue; // background agents (claude -p / SDK), incl. the dock's own
    try { process.kill(j.pid, 0); } catch { continue; } // process gone
    if (j.sessionId) out.push(j);
  }
  return out;
}
const dockPids = () => new Set([...procs.values()].map(p => p.child.pid));
function listSessions() {
  const out = [];
  const owned = new Set();
  for (const s of state.sessions) {
    owned.add(s.sessionId);
    if (s.hidden) continue;
    // a session opened but never used (no message sent) tidies itself away after 30 minutes
    if (!s.sessionId && !(s.log && s.log.some(t => t.user)) && !procs.get(s.id)?.busy && Date.now() - s.created > 30 * 60e3) {
      const p0 = procs.get(s.id); if (p0) (p0.pipe ? killTree(p0) : p0.child.kill("SIGTERM"));
      s.hidden = true; saveState(); continue;
    }
    const p = procs.get(s.id);
    if (s.kind === "pipe" || s.kind === "api") {
      const status = p?.busy ? "cooking" : deadErr.get(s.id) ? "error" : p?.unread ? "answered" : "idle";
      const lt = [...(s.log || [])].reverse().find(t => t.answer || t.user);
      out.push({ id: s.id, kind: "dock", local: true, label: s.label, color: s.color, title: s.kind === "api" ? null : p ? null : "not running",
        status, last: lt ? (lt.answer || "you: " + lt.user).replace(/\s+/g, " ").slice(0, 140) : "", updated: lt?.end || lt?.ts || s.created, running: !!p });
      continue;
    }
    const tp = findTranscript(s.sessionId);
    const f = tp ? readFileModel(tp) : null;
    const m = f?.model;
    const ask = !p?.busy && !p?.perm ? askOf(lastAnswer(m)) : null;
    const status = p?.perm ? "needs" : p?.busy ? "cooking" : (p?.err || deadErr.get(s.id)) ? "error" : ask ? "yourturn" : p?.unread ? "answered" : "idle";
    out.push({ id: s.id, kind: "dock", label: s.label, color: s.color, title: m?.title || null,
      status, ask, last: lastLine(m), updated: f?.mtime || s.created, running: !!p });
  }
  // Terminal sessions: only ones whose Claude process is actually running right now.
  // Claude Code writes ~/.claude/sessions/<pid>.json for every live session.
  const now = Date.now();
  for (const live of liveTerminalSessions()) {
    if (owned.has(live.sessionId) || dockPids().has(live.pid)) continue;
    const tp = findTranscript(live.sessionId); if (!tp) continue;
    const f = readFileModel(tp); const m = f.model;
    const lab = labelFor(m.cwd || live.cwd);
    out.push({ id: "t:" + live.sessionId, kind: "terminal", label: lab.label, color: lab.color, title: m.title,
      status: live.status === "busy" || (!live.status && now - f.mtime < LIVE_MS) ? "cooking" : "idle", last: lastLine(m), updated: f.mtime, live: true });
  }
  out.sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
  return out;
}
const rank = s => ({ needs: 0, yourturn: 0.5, error: 1, answered: 2, cooking: 3, idle: 4 }[s.status] ?? 5);
// "Your turn" (10/4): when the latest answer asks Matt something, pull out that question so the list and
// the chat can say plainly that the session is waiting on him. Last paragraph with a "?" -> its last question.
function lastAnswer(m) {
  if (!m || !m.turns.length) return "";
  const t = m.turns[m.turns.length - 1], st = t.steps || [];
  for (let j = st.length - 1; j >= 0; j--) if (st[j].k === "text" && st[j].text.trim()) return st[j].text;
  return "";
}
function askOf(text) {
  if (!text) return null;
  const paras = text.trim().split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  for (const para of paras.slice(-2).reverse()) {
    if (!para.includes("?")) continue;
    const plain = para.replace(/[*_`#>]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ");
    const qs = plain.match(/[^.!?]*\?/g); if (!qs) continue;
    const q = qs[qs.length - 1].trim(); if (q.length < 8) continue;
    return q.length > 240 ? "…" + q.slice(-240) : q;
  }
  return null;
}
function lastLine(m) {
  if (!m) return "";
  for (let i = m.turns.length - 1; i >= 0; i--) {
    const st = m.turns[i].steps; for (let j = st.length - 1; j >= 0; j--) if (st[j].k === "text") return st[j].text.replace(/\s+/g, " ").slice(0, 140);
    if (m.turns[i].user) return "you: " + m.turns[i].user.replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

// every shaped turn of a session, with all its work (the detail view gets a lean copy)
function fullTurns(id) {
  if (id.startsWith("t:")) {
    const sid = id.slice(2); const tp = findTranscript(sid); if (!tp) return null;
    const f = readFileModel(tp);
    const live = liveTerminalSessions().find(x => x.sessionId === sid);
    const busy = live ? live.status === "busy" : Date.now() - f.mtime < LIVE_MS;
    return shapeTurns(f.model, busy);
  }
  const s = state.sessions.find(x => x.id === id); if (!s) return null;
  const p = procs.get(id);
  if (s.kind === "pipe" || s.kind === "api") return (s.log || []).map((t, i, a) => ({ i, user: t.user, answer: t.answer || null, work: [], open: !!p?.busy && i === a.length - 1, secs: t.end ? Math.round((t.end - t.ts) / 1000) : null }));
  const tp = findTranscript(s.sessionId); const f = tp ? readFileModel(tp) : null;
  const turns = f ? shapeTurns(f.model, !!p?.busy) : [];
  if (p?.busy && (!turns.length || !turns[turns.length - 1].open)) turns.push({ i: turns.length, user: p.pendingText || null, answer: null, work: [], open: true });
  return turns;
}
// ---------- background jobs (10/4) ----------
// Long tasks an agent kicks off on this machine register themselves in ~/.claude/job-board
// (helper: ~/.claude/bin/job). Every open chat on this machine shows them as a pulsing card
// with progress + ETA, so Matt can see work is happening between replies.
const JOB_DIR = path.join(HOME, ".claude", "job-board");
function readJobs() {
  let names = []; try { names = fs.readdirSync(JOB_DIR).filter(f => f.endsWith(".json")); } catch { return []; }
  const now = Date.now() / 1000, out = [];
  for (const f of names) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), "utf8")); } catch { continue; }
    if (j.pid && !alive(j.pid)) continue;
    if (now - (j.updated || now) > 6 * 3600) continue;
    out.push({ id: f.slice(0, -5), label: j.label, start: j.start, total: j.total || null, done: j.done || 0, eta_end: j.eta_end || null });
  }
  return out.sort((a, b) => (a.start || 0) - (b.start || 0));
}
// Background work Claude starts inside a chat (Agent calls, run_in_background Bash, Monitors) is read
// straight from that chat's transcript: started when the tool_use lands, finished when its
// <task-notification> says completed/failed/killed. The live line is the agent's latest step (from its
// subagents/agent-<id>.jsonl) or the last line of the command's output file. ETA = a "~5m" hint in the
// description, else the median of how long this kind of task took before (bg-history.json), else a default.
const BG_HIST_FILE = path.join(__dirname, "bg-history.json");
let bgHist = {}; try { bgHist = JSON.parse(fs.readFileSync(BG_HIST_FILE, "utf8")); } catch {}
bgHist.d = bgHist.d || {}; bgHist.seen = bgHist.seen || [];
const bgScan = new Map(); // transcript path -> {off, rest, tasks: Map(toolUseId -> task)}
const BG_DEFAULT = { agent: 180, bash: 120, monitor: 300 };
function bgEtaSecs(t) {
  const m = /~\s*(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?|s|sec)\b/i.exec(t.label || "");
  if (m) { const n = +m[1], u = m[2][0].toLowerCase(); return u === "h" ? n * 3600 : u === "m" ? n * 60 : n; }
  const arr = bgHist.d[t.kind] || [];
  if (arr.length >= 3) { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; }
  return BG_DEFAULT[t.kind] || 120;
}
function bgRecord(t, endMs) {
  if (bgHist.seen.includes(t.id)) return;
  const secs = (endMs - t.startMs) / 1000; if (!(secs > 1 && secs < 6 * 3600)) return;
  (bgHist.d[t.kind] = bgHist.d[t.kind] || []).push(Math.round(secs));
  if (bgHist.d[t.kind].length > 30) bgHist.d[t.kind].shift();
  bgHist.seen.push(t.id); if (bgHist.seen.length > 300) bgHist.seen.splice(0, 100);
  try { fs.writeFileSync(BG_HIST_FILE, JSON.stringify(bgHist)); } catch {}
}
function textOf(c) { return typeof c === "string" ? c : Array.isArray(c) ? c.map(x => x?.text || "").join("\n") : ""; }
function bgScanFile(tp) {
  let st; try { st = fs.statSync(tp); } catch { return null; }
  let e = bgScan.get(tp);
  if (!e || st.size < e.off) { e = { off: 0, rest: "", tasks: new Map() }; bgScan.set(tp, e); }
  if (st.size > e.off) {
    const fd = fs.openSync(tp, "r"); const buf = Buffer.alloc(st.size - e.off); fs.readSync(fd, buf, 0, buf.length, e.off); fs.closeSync(fd);
    e.off = st.size; const lines = (e.rest + buf.toString("utf8")).split("\n"); e.rest = lines.pop();
    for (const line of lines) {
      if (!line.includes("tool_use") && !line.includes("task-notification") && !line.includes("in background") && !line.includes("moved to the background")) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.isSidechain) continue;
      const ts = Date.parse(j.timestamp || "") || Date.now();
      const content = j.message?.content;
      if (j.type === "assistant" && Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== "tool_use") continue;
          const inp = c.input || {};
          if (c.name === "Agent" && inp.run_in_background !== false)
            e.tasks.set(c.id, { id: c.id, kind: "agent", label: inp.description || "Background agent", startMs: ts, open: true });
          else if (c.name === "Bash" && inp.run_in_background)
            e.tasks.set(c.id, { id: c.id, kind: "bash", label: inp.description || "Background command", startMs: ts, open: true });
          else if (c.name === "Monitor")
            e.tasks.set(c.id, { id: c.id, kind: "monitor", label: "Watching: " + (inp.description || "a background job"), startMs: ts, open: true });
          else if (c.name === "Bash") e.tasks.set(c.id, { id: c.id, kind: "bash", label: inp.description || "Command", startMs: ts, open: false, pending: true });
        }
      }
      if (j.type === "user" && Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== "tool_result") continue; const t = e.tasks.get(c.tool_use_id); if (!t) continue;
          const txt = textOf(c.content);
          const of = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(txt) || /output_file: (\S+)/.exec(txt);
          if (t.pending) { delete t.pending; if (/moved to the background/.test(txt)) t.open = true; else { e.tasks.delete(c.tool_use_id); continue; } }
          if (of) t.outFile = of[1];
          const aid = /agentId: (\w+)/.exec(txt); if (aid) t.agentId = aid[1];
          if (/Async agent launched|running in background|moved to the background|Monitor started/.test(txt) === false && t.kind !== "agent") { t.open = false; }
        }
      }
      const raw = j.type === "user" ? textOf(content) : (j.type === "queue-operation" ? j.content || "" : "");
      if (raw.includes("<task-notification>")) {
        const id = /<tool-use-id>([^<]+)</.exec(raw)?.[1], status = /<status>([^<]+)</.exec(raw)?.[1];
        const t = id && e.tasks.get(id);
        if (t && t.open && /completed|failed|killed|stopped|cancel|timeout/i.test(status || "")) { t.open = false; if (/completed/i.test(status)) bgRecord(t, ts); }
      }
    }
    for (const [k, t] of e.tasks) if (!t.open && !t.pending) e.tasks.delete(k);
  }
  return e;
}
function tailLines(file, bytes = 16384) {
  try { const st = fs.statSync(file); const n = Math.min(bytes, st.size); const fd = fs.openSync(file, "r"); const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd); return { text: b.toString("utf8"), mtime: st.mtimeMs }; } catch { return null; }
}
function agentStep(sub) {
  const t = tailLines(sub, 65536); if (!t) return null;
  const lines = t.text.split("\n").reverse();
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const c = j.message?.content; if (j.type !== "assistant" || !Array.isArray(c)) continue;
    for (const x of [...c].reverse()) {
      if (x.type === "tool_use") { const i = x.input || {};
        const what = i.query ? `Searching: ${i.query}` : i.url ? `Reading ${String(i.url).replace(/^https?:\/\//, "").slice(0, 70)}`
          : i.description ? i.description : i.file_path ? `Reading ${path.basename(i.file_path)}` : i.pattern ? `Searching files for ${i.pattern}` : i.command ? `Running ${String(i.command).slice(0, 60)}` : x.name;
        return { line: what, at: t.mtime }; }
      if (x.type === "text" && x.text?.trim()) return { line: "Writing up what it found", at: t.mtime };
    }
  }
  return { line: "Getting started", at: t.mtime };
}
function outStep(file) {
  const t = tailLines(file, 8192); if (!t) return null;
  const segs = t.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
  return { line: segs.length ? segs[segs.length - 1].slice(0, 110) : "Working (no output yet)", at: t.mtime };
}
function bgTasks(tp) {
  if (!tp) return [];
  const e = bgScanFile(tp); if (!e) return [];
  const subDir = tp.replace(/\.jsonl$/, ""), out = [];
  for (const t of e.tasks.values()) {
    if (!t.open) continue;
    let step = null;
    if (t.kind === "agent" && t.agentId) step = agentStep(path.join(subDir, "subagents", `agent-${t.agentId}.jsonl`));
    else if (t.outFile) step = outStep(t.outFile);
    const eta = bgEtaSecs(t);
    out.push({ id: t.id, kind: t.kind, label: t.label, start: t.startMs / 1000, eta_end: t.startMs / 1000 + eta, total: null, done: 0,
      step: step?.line || null, stepAt: step?.at ? step.at / 1000 : null });
  }
  return out.sort((a, b) => a.start - b.start);
}

let jobSig = "";
setInterval(() => { const sig = JSON.stringify(readJobs()); if (sig !== jobSig) { jobSig = sig; broadcast(); } }, 2000);

function sessionDetail(id) {
  if (id.startsWith("t:")) {
    const sid = id.slice(2); const tp = findTranscript(sid); if (!tp) return null;
    const f = readFileModel(tp); const lab = labelFor(f.model.cwd);
    const live = liveTerminalSessions().some(x => x.sessionId === sid);
    return { id, kind: "terminal", label: lab.label, color: lab.color, title: f.model.title, cwd: f.model.cwd,
      live, turns: lean(fullTurns(id)), jobs: bgTasks(tp).concat(readJobs()) };
  }
  const s = state.sessions.find(x => x.id === id); if (!s || s.hidden) return null;   // ended = gone from every window
  const p = procs.get(id);
  if (p) p.unread = false;
  const tp = s.kind === "pipe" || s.kind === "api" ? null : findTranscript(s.sessionId); const f = tp ? readFileModel(tp) : null;
  const turns = lean(fullTurns(id));
  return { id, kind: "dock", label: s.label, color: s.color, title: f?.model.title || null, cwd: s.cwd,
    busy: !!p?.busy, perm: p?.perm ? { request_id: p.perm.request_id, tool: p.perm.tool, line: p.perm.line, question: p.perm.question } : null,
    err: p?.err || deadErr.get(id) || null, turns, jobs: bgTasks(tp).concat(readJobs()),
    ask: !p?.busy && !p?.perm && f ? askOf(lastAnswer(f.model)) : null };
}

// ---------- SSE ----------
const clients = new Set();
let bTimer = null;
let lastFocus = null; // {id, at}: a Desktop launcher just started this session; local windows jump to it
function broadcast(id) {
  if (bTimer) return;
  bTimer = setTimeout(() => { bTimer = null; for (const c of clients) c.write(`data: ${JSON.stringify({ t: Date.now(), v: pageVersion(), focus: c.local ? lastFocus : undefined })}\n\n`); }, 250);
}
// the page reloads itself when index.html changes, so design tweaks show up without a click
const pageVersion = () => { try { return Math.round(fs.statSync(path.join(__dirname, "public", "index.html")).mtimeMs); } catch { return 0; } };
let lastPage = pageVersion();
setInterval(() => { const v = pageVersion(); if (v !== lastPage) { lastPage = v; broadcast(); } }, 2000);
// transcripts change without us knowing; watch only the ones on screen (live terminals + dock
// sessions). Stat-ing every transcript on disk every 2s costs real CPU once there are thousands of them.
let sizes = "";
setInterval(() => {
  let sig = "";
  const ids = new Set([...liveTerminalSessions().map(x => x.sessionId + x.status), ...state.sessions.filter(x => !x.hidden).map(x => x.sessionId)]);
  for (const id of ids) {
    const sid = String(id).replace(/(busy|idle|shell|waiting)$/, ""), tp = findTranscriptCached(sid);
    try { sig += id + (tp ? fs.statSync(tp).size : 0); } catch {}
  }
  if (sig !== sizes) { sizes = sig; broadcast(); }
}, 1500);
setInterval(broadcast, 30000); // keep "x min ago" and live flags fresh
// heartbeat: keeps tunnels/proxies from idling the stream out, and lets the hub spot a dead peer stream
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000);

// ---------- peers (other machines' docks, reached through ssh tunnels on 127.0.0.1) ----------
function localState() {
  return { machine: { id: CONFIG.machine, name: CONFIG.name, color: CONFIG.color, gpu: gpuCache, mem: memCache, online: true },
    sessions: listSessions().map(s => ({ ...s, machine: CONFIG.machine })), launchers: launchers.map(({ id, label, color, kind, group, note }) => ({ id, label, color, kind: kind || "claude", group: group || "cloud", note })) };
}
function peerFetch(peer, method, p, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(peer.url + p);
    const r = http.request({ host: "127.0.0.1", port: u.port, path: u.pathname, method, timeout: 4000,
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-dock": "1" } }, res => {
      let b = ""; res.on("data", c => (b += c)); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = { error: b }; } resolve({ code: res.statusCode, body: j }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", reject);
    if (data) r.write(JSON.stringify(data)); r.end();
  });
}
const peerCache = new Map(); // peer id -> {r, at, pending}
function refreshPeer(peer) {
  const c = peerCache.get(peer.id) || {}; if (c.pending) return c.pending;
  c.pending = (peer.url ? peerFetch(peer, "GET", "/api/local").catch(() => null) : Promise.resolve(null))
    .then(r => { c.r = r && r.code === 200 ? r : null; c.at = Date.now(); c.pending = null; return c.r; });
  peerCache.set(peer.id, c); return c.pending;
}
function peerState(peer) {
  const c = peerCache.get(peer.id);
  if (c && c.at && Date.now() - c.at < 20000) return Promise.resolve(c.r);
  return refreshPeer(peer);
}
setInterval(() => CONFIG.peers.forEach(refreshPeer), 15000);
// relay each peer's change events so the page refreshes when something moves on another machine
for (const peer of CONFIG.peers) {
  if (!peer.url) continue;
  const connect = () => {
    const u = new URL(peer.url + "/api/events");
    let last = Date.now(), done = false;
    const again = () => { if (done) return; done = true; clearInterval(watch); setTimeout(connect, 3000); };
    const r = http.get({ host: "127.0.0.1", port: u.port, path: u.pathname, headers: { host: "127.0.0.1" } }, res => {
      let t = null;
      res.on("data", chunk => {
        last = Date.now();
        if (String(chunk).startsWith(":")) return; // heartbeat only
        clearTimeout(t); t = setTimeout(() => refreshPeer(peer).then(() => broadcast()), 100);
      });
      res.on("end", again); res.on("error", again);
    });
    r.on("error", again);
    // a stream that went quiet (tunnel hiccup) never errors on its own; drop it and reconnect
    const watch = setInterval(() => { if (Date.now() - last > 40000) { r.destroy(); again(); } }, 10000);
  };
  connect();
}

// Claude plan usage for the bar at the top (Matt 10/5): 5-hour and weekly percent + reset times, the same
// numbers claude.ai/settings/usage shows. A Mac reads it with ~/Scripts/claude-usage/usage.py (Claude Code's
// own keychain login); a machine without it asks its peers. Cached a minute.
let usageCache = { at: 0, body: null };
async function claudeUsage(fromPeer) {
  if (usageCache.body && Date.now() - usageCache.at < 60000) return usageCache.body;
  const sc = path.join(HOME, "Scripts", "claude-usage", "usage.py");
  let body = null;
  if (!WIN && fs.existsSync(sc)) body = await new Promise(ok => execFile("/usr/bin/python3", [sc], { timeout: 15000 }, (e, out) => {
    try { const j = JSON.parse(out); ok(j.five_hour ? { five: j.five_hour, week: j.seven_day, limits: j.limits || [], at: Date.now() } : null); } catch { ok(null); } }));
  // the PC (no python, no keychain): Claude Code keeps its login in ~/.claude/.credentials.json there
  const cred = path.join(HOME, ".claude", ".credentials.json");
  if (!body && fs.existsSync(cred)) body = await new Promise(ok => {
    let tok; try { tok = JSON.parse(fs.readFileSync(cred, "utf8")).claudeAiOauth.accessToken; } catch { return ok(null); }
    const r = require("https").get("https://api.anthropic.com/api/oauth/usage", { timeout: 10000,
      headers: { Authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code" } }, x => {
      let t = ""; x.on("data", c => (t += c)); x.on("end", () => { try { const j = JSON.parse(t); ok(j.five_hour ? { five: j.five_hour, week: j.seven_day, limits: j.limits || [], at: Date.now() } : null); } catch { ok(null); } }); });
    r.on("error", () => ok(null)); r.on("timeout", () => { r.destroy(); ok(null); });
  });
  if (!body && !fromPeer) for (const p of CONFIG.peers) {
    if (!p.url) continue;
    const t = await getJSON(p.url + "/api/usage?peer=1", 8000);
    try { const j = JSON.parse(t); if (j.five) { body = j; break; } } catch {}
  }
  if (body) usageCache = { at: Date.now(), body };
  return body || usageCache.body;
}
// every machine's sessions and launchers in one list, with the best machine marked per launcher
async function buildState() {
      const local = localState();
      const machines = [local.machine], sessions = [...local.sessions], launch = local.launchers.map(l => ({ ...l, machine: local.machine.id }));
      await Promise.all(CONFIG.peers.map(async peer => {
        const r = await peerState(peer);
        if (!r || r.code !== 200) { machines.push({ id: peer.id, name: peer.name, color: peer.color, online: false, note: peer.url ? "not answering" : "not linked yet" }); return; }
        machines.push({ ...r.body.machine, id: peer.id, name: peer.name, color: peer.color || r.body.machine.color, online: true });
        for (const x of r.body.sessions) sessions.push({ ...x, id: peer.id + "~" + x.id, machine: peer.id });
        for (const l of r.body.launchers) launch.push({ ...l, machine: peer.id });
      }));
      // best machine for each launcher that exists on several: skip offline, then fewest sessions
      // working or waiting, then lowest GPU, then config "prefer" order (default: this machine, then peers)
      const prefOrder = CONFIG.prefer || [CONFIG.machine, ...CONFIG.peers.map(p => p.id)];
      const pref = Object.fromEntries(prefOrder.map((id, i) => [id, i]));
      const load = m => sessions.filter(x => x.machine === m && ["cooking", "needs"].includes(x.status)).length;
      const score = m => { const mm = machines.find(x => x.id === m); return load(m) * 100 + (mm?.gpu || 0) / 4 + (pref[m] ?? prefOrder.length) * 5; };
      for (const label of new Set(launch.map(l => l.label))) {
        const opts = launch.filter(l => l.label === label && machines.find(m => m.id === l.machine)?.online);
        if (opts.length > 1) opts.reduce((a, b) => (score(b.machine) < score(a.machine) ? b : a)).best = true;
      }
      const order = [CONFIG.machine, ...CONFIG.peers.map(p => p.id)];
      machines.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  return { machines, sessions, launchers: launch };
}

// ---------- HTTP ----------
function body(req) {
  return new Promise((res, rej) => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }

// ---------- push to talk ----------
// The mic button posts one recording here and gets text back. Everything runs on this
// machine: ffmpeg to 16k mono, then whisper. Nothing is uploaded anywhere.
// config.json can override: "stt": {"model": "...", "python": "...", "cmd": "...", "args": ["{file}"]}
function rawBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > max) { req.destroy(); return reject(new Error("that was too long")); } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const runTool = (cmd, args, ms) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 24, timeout: ms || 180000 }, (e, so, se) => {
    if (!e) return resolve(so.toString());
    const last = String(se || e.message || "").trim().split("\n").filter(Boolean).pop();
    reject(new Error(last || "failed"));
  }));
// one line so it survives being passed as -c; prints the transcript and nothing else
const MLX_WHISPER = "import sys, mlx_whisper; print(mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2])['text'].strip())";
// checked once per process: is there anything on this machine that can hear?
let sttReady = null;
async function sttAvailable(stt, py) {
  if (stt.cmd) return true;
  if (sttReady !== null) return sttReady;
  if (WIN) return (sttReady = false);
  sttReady = await runTool(py, ["-c", "import importlib.util as u, sys; sys.exit(0 if u.find_spec('mlx_whisper') else 1)"], 20000)
    .then(() => true).catch(() => false);
  return sttReady;
}
// a machine with no whisper of its own hands the clip to one that has it (config: stt.forward)
function forwardStt(target, buf) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const r = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/octet-stream", "x-dock": "1", "content-length": buf.length } },
      resp => { let b = ""; resp.on("data", c => b += c); resp.on("end", () => {
        let j; try { j = JSON.parse(b); } catch { return reject(new Error("the transcriber sent back something odd")); }
        return j.error ? reject(new Error(j.error)) : resolve(j.text);
      }); });
    r.on("error", () => reject(new Error("couldn't reach the machine that transcribes")));
    r.setTimeout(180000, () => r.destroy());
    r.end(buf);
  });
}
async function transcribe(buf) {
  const stt = CONFIG.stt || {};
  if (!await sttAvailable(stt, stt.python || "/usr/bin/python3")) {
    if (stt.forward) return forwardStt(stt.forward, buf);
    throw new Error("this machine can't transcribe - install mlx_whisper, set stt.cmd, or set stt.forward to a machine that can");
  }
  const base = path.join(os.tmpdir(), "moonstone-stt-" + Date.now());
  const webm = base + ".webm", wav = base + ".wav";
  fs.writeFileSync(webm, buf);
  try {
    await runTool(stt.ffmpeg || "ffmpeg", ["-y", "-i", webm, "-ar", "16000", "-ac", "1", "-f", "wav", wav], 60000)
      .catch(e => { throw new Error("ffmpeg could not read the recording: " + e.message); });
    if (stt.cmd) return (await runTool(stt.cmd, (stt.args || ["{file}"]).map(a => a.replace("{file}", wav)))).trim();
    if (WIN) throw new Error("this machine has no transcriber - set stt.cmd or stt.forward in config.json");
    return (await runTool(stt.python || "/usr/bin/python3",
      ["-c", MLX_WHISPER, wav, stt.model || "mlx-community/whisper-large-v3-turbo"])).trim();
  } finally {
    for (const f of [webm, wav]) { try { fs.unlinkSync(f); } catch {} }
  }
}

let narrOwner = { id: null, at: 0 };   // which open Moonstone window narrates (one voice, even with windows on every machine)
const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host)) { res.writeHead(403); return res.end("local only"); }
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  // A copy of Moonstone served from somewhere else (a reverse proxy, say) can reach the server on the
  // machine you're sitting at for one thing: the mic. Only origins listed in config "remoteOrigins", only /api/dictate.
  if (url.pathname === "/api/dictate" && req.headers.origin && (CONFIG.remoteOrigins || []).includes(req.headers.origin)) {
    res.setHeader("access-control-allow-origin", req.headers.origin);
    res.setHeader("access-control-allow-headers", "content-type, x-dock");
    res.setHeader("access-control-allow-methods", "POST");
    res.setHeader("access-control-allow-private-network", "true");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/local") return json(res, 200, localState());
    if (req.method === "GET" && url.pathname === "/api/usage") return json(res, 200, (await claudeUsage(url.searchParams.get("peer") === "1")) || { none: true });
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await buildState());
    if (req.method === "GET" && url.pathname === "/api/clients") return json(res, 200, { local: [...clients].filter(c => c.local).length });
    // anything addressed to "<peer>~<id>" goes to that machine's dock
    const pid = parts[0] === "api" && parts[1] === "session" && parts[2] ? decodeURIComponent(parts[2]) : null;
    const peerOf = id => { const i = id ? id.indexOf("~") : -1; return i > 0 ? CONFIG.peers.find(p => p.id === id.slice(0, i)) : null; };
    if (pid && peerOf(pid)) {
      const peer = peerOf(pid); const rest = "/" + parts.slice(0, 2).join("/") + "/" + encodeURIComponent(pid.slice(peer.id.length + 1)) + (parts[3] ? "/" + parts.slice(3).join("/") : "");
      const r = await peerFetch(peer, req.method, rest, req.method === "POST" ? await body(req) : null).catch(e => ({ code: 502, body: { error: "the " + peer.name + " isn't answering" } }));
      if (r.body && typeof r.body === "object" && r.code === 200 && req.method === "GET") { r.body.id = pid; r.body.machine = peer.id; }
      if (r.body && typeof r.body === "object" && r.code === 200 && req.method === "POST" && r.body.id) r.body.id = peer.id + "~" + r.body.id;
      return json(res, r.code, r.body);
    }
    if (req.method === "POST" && (url.pathname === "/api/launch" || url.pathname === "/api/continue")) {
      const b = await body(req); req.parsedBody = b;
      if (b.machine === "auto" && url.pathname === "/api/launch") {  // Desktop launchers let Moonstone pick
        const st = await buildState(); const l = launchers.find(x => x.id === b.launcher);
        const opts = st.launchers.filter(x => x.label === l?.label);
        b.machine = (opts.find(x => x.best) || opts.find(x => x.machine === CONFIG.machine) || opts[0] || {}).machine || CONFIG.machine;
        b.launcher = (opts.find(x => x.machine === b.machine) || {}).id || b.launcher;
      }
      if (b.focus) { const wrap = res.end.bind(res); res.end = (data, ...a) => {   // tell local windows to open it
        try { const j = JSON.parse(data); if (j.id) { lastFocus = { id: j.id, at: Date.now() }; broadcast(); } } catch {}
        return wrap(data, ...a); }; }
      const peer = b.machine && b.machine !== CONFIG.machine ? CONFIG.peers.find(p => p.id === b.machine) : null;
      if (peer) {
        const r = await peerFetch(peer, "POST", url.pathname, b).catch(() => ({ code: 502, body: { error: "the " + peer.name + " isn't answering" } }));
        if (r.code === 200 && r.body.id) r.body.id = peer.id + "~" + r.body.id;
        return json(res, r.code, r.body);
      }
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[2] && parts[3] === "work") {
      const all = fullTurns(decodeURIComponent(parts[2])); const t = all && all[+parts[4]];
      return t ? json(res, 200, { work: t.work }) : json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[2]) {
      const d = sessionDetail(decodeURIComponent(parts[2])); if (d) d.machine = CONFIG.machine;
      return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/narrator") return json(res, 200, narrOwner);
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.local = !req.headers["x-via-proxy"];  // a reverse proxy in front of Moonstone should add X-Via-Proxy; no header = a window on this machine
      res.write("retry: 2000\n\n"); res.write(`data: ${JSON.stringify({ t: Date.now(), v: pageVersion(), focus: res.local ? (lastFocus || { id: null, at: 0 }) : undefined })}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "POST") {
      if (req.headers["x-dock"] !== "1") { res.writeHead(403); return res.end("missing header"); }
      if (url.pathname === "/api/stt") {   // the mic button: raw audio in, text out. Must run before body() - this one isn't JSON.
        const t0 = Date.now();
        const buf = await rawBody(req, 25e6).catch(() => null);
        if (!buf || buf.length < 1500) return json(res, 400, { error: "I didn't catch that" });
        try { return json(res, 200, { text: await transcribe(buf), ms: Date.now() - t0 }); }
        catch (e) { return json(res, 503, { error: String(e.message || e) }); }
      }
      const b = req.parsedBody || await body(req);
      if (url.pathname === "/api/dictate") {   // mic button: flip the computer's own dictation (Mac Edit menu helper / Windows Win+H)
        if (req.headers["x-via-proxy"]) return json(res, 409, { error: "not at this machine" });   // the keys would land on the wrong screen
        const d = CONFIG.dictate || {};
        if (d.off) return json(res, 409, { error: "dictation off here" });
        try {
          if (WIN) {
            const ps = "$w=Add-Type -PassThru -Name K -Namespace D -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);';" +
              "$w::keybd_event(0x5B,0,0,[UIntPtr]::Zero);$w::keybd_event(0x48,0,0,[UIntPtr]::Zero);$w::keybd_event(0x48,0,2,[UIntPtr]::Zero);$w::keybd_event(0x5B,0,2,[UIntPtr]::Zero)";
            await new Promise((ok, bad) => execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 8000 }, e => e ? bad(e) : ok()));
          } else {
            const app = d.app || path.join(HOME, "Applications", "Moonstone Dictate.app");
            const out = path.join(__dirname, "dictate.out");
            const mode = b.want === "stop" ? "stop" : b.want === "start" ? "start" : (d.args || ["start"])[0];
            const press = () => new Promise((ok, bad) => { try { fs.unlinkSync(out); } catch {}
              // no -W: the helper often exits before open can wait on it ("kevent failed"); poll for its answer instead
              execFile("/usr/bin/open", ["-g", "--stdout", out, app, "--args", mode], { timeout: 8000 }, async e => {
                if (e) return bad(e);
                let said = ""; for (let i = 0; i < 280 && !said; i++) { await new Promise(z => setTimeout(z, 50)); try { said = fs.readFileSync(out, "utf8").trim(); } catch {} }
                fs.appendFile(path.join(__dirname, "dictate.log"), `${new Date().toLocaleTimeString()} want=${mode} ${said || "(no answer)"}\n`, () => {});
                ok(said); }); });
            // The helper opens the Edit menu, reads whether dictation is on, and clicks only if that changes it.
            const said = await press();
            if (!said || /no-dictation-item|needs-permission|no-menu-bar|no-edit-menu|no-front-app|unchanged/.test(said)) return json(res, 503, { error: said });
          }
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 503, { error: String(e.message || e) }); }
      }
      if (url.pathname === "/api/narrator") {   // the window you touched last is the one that reads answers out loud
        narrOwner = { id: String(b.id || "").slice(0, 40), at: Date.now() }; return json(res, 200, narrOwner);
      }
      if (url.pathname === "/api/tts") {   // narration: text in, wav out, from a local Kokoro server (config "tts")
        const tts = CONFIG.tts || {};
        const text = String(b.text || "").slice(0, 4000).trim();
        if (!text) return json(res, 400, { error: "nothing to say" });
        try {
          const r = await fetch(tts.url || "http://127.0.0.1:7864/tts", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, voice: tts.voice || "af_heart", speed: tts.speed || 1.0 }), signal: AbortSignal.timeout(60000) });
          const wav = Buffer.from(await r.arrayBuffer());
          if (!r.ok || wav.slice(0, 4).toString() !== "RIFF") throw new Error("voice server said " + r.status);
          res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" }); return res.end(wav);
        } catch (e) { return json(res, 503, { error: String(e.message || e) }); }
      }
      if (url.pathname === "/api/launch") {
        launchers = loadLaunchers();
        const l = launchers.find(x => x.id === b.launcher); if (!l) return json(res, 400, { error: "unknown launcher" });
        if (l.kind === "open") {
          spawn(WIN ? "cmd" : "/usr/bin/open", WIN ? ["/c", "start", "", l.path] : [l.path], { detached: true, stdio: "ignore" }).unref();
          return json(res, 200, { opened: true, label: l.label });
        }
        if (l.kind === "api") {
          const s = { id: crypto.randomUUID().slice(0, 8), kind: "api", launcher: l.id, cwd: l.cwd, label: l.label, color: l.color, created: Date.now(), log: [] };
          state.sessions.push(s); saveState(); broadcast();
          ensureServer(l, () => {}); // start loading now so the first answer is quicker
          return json(res, 200, { id: s.id });
        }
        if (l.kind === "pipe") {
          const s = { id: crypto.randomUUID().slice(0, 8), kind: "pipe", cmd: l.cmd, cwd: l.cwd, label: l.label, color: l.color, created: Date.now(), log: [] };
          state.sessions.push(s); startPipe(s); saveState(); broadcast();
          return json(res, 200, { id: s.id });
        }
        const s = takeSpare(l) || { id: crypto.randomUUID().slice(0, 8), sessionId: null, cwd: l.cwd, label: l.label, mode: l.mode, color: l.color, created: Date.now() };
        state.sessions.push(s); saveState(); setTimeout(fillSpares, 1000);
        if (b.text) send(s, b.text);
        // "opening": a shell command whose output is the chat's first message (Story Forge's briefing,
        // 2026-10-05). bash on macOS/Linux, PowerShell on Windows (no /bin/bash there).
        else if (l.opening) execFile(WIN ? "powershell" : "/bin/bash", WIN ? ["-NoProfile", "-Command", String(l.opening)] : ["-c", String(l.opening)], { cwd: l.cwd, timeout: 60000, windowsHide: true }, (e, out) => { const t = String(out || "").trim(); if (t) send(s, t); });
        broadcast(); return json(res, 200, { id: s.id });
      }
      if (url.pathname === "/api/continue") { // resume a terminal transcript inside the dock
        const sid = String(b.sessionId || ""); const tp = findTranscript(sid); if (!tp) return json(res, 404, { error: "not found" });
        const f = readFileModel(tp); const lab = labelFor(f.model.cwd); const l = launcherFor(f.model.cwd);
        let s = state.sessions.find(x => x.sessionId === sid);
        if (!s) { s = { id: crypto.randomUUID().slice(0, 8), sessionId: sid, cwd: f.model.cwd || HOME, label: lab.label, mode: l?.mode || "default", color: lab.color, created: Date.now() }; state.sessions.push(s); }
        s.hidden = false; saveState(); broadcast(); return json(res, 200, { id: s.id });
      }
      // typing into a session that lives in a terminal window: quietly move it into the dock
      // (stop the terminal's Claude, resume the same conversation here with full history, send)
      if (parts[2] && decodeURIComponent(parts[2]).startsWith("t:") && parts[3] === "send") {
        const sid = decodeURIComponent(parts[2]).slice(2); const text = String(b.text || "");
        if (!text.trim()) return json(res, 400, { error: "empty" });
        const live = liveTerminalSessions().find(x => x.sessionId === sid);
        if (live) await stopTerminalSession(live.pid);
        const tp = findTranscript(sid); if (!tp) return json(res, 404, { error: "not found" });
        const f = readFileModel(tp); const lab = labelFor(f.model.cwd); const l = launcherFor(f.model.cwd);
        let s = state.sessions.find(x => x.sessionId === sid);
        if (!s) { s = { id: crypto.randomUUID().slice(0, 8), sessionId: sid, cwd: f.model.cwd || HOME, label: lab.label, mode: l?.mode || "default", color: lab.color, created: Date.now() }; state.sessions.push(s); }
        s.hidden = false; saveState(); send(s, text);
        return json(res, 200, { ok: true, id: s.id });
      }
      // ending a session that lives in a terminal: stop that Claude process (the terminal window stays open)
      if (parts[2] && decodeURIComponent(parts[2]).startsWith("t:") && parts[3] === "close") {
        const sid = decodeURIComponent(parts[2]).slice(2);
        const live = liveTerminalSessions().find(x => x.sessionId === sid);
        if (!live) return json(res, 404, { error: "that session isn't running" });
        await stopTerminalSession(live.pid);
        setTimeout(broadcast, 500); return json(res, 200, { ok: true });
      }
      const s = state.sessions.find(x => x.id === parts[2]);
      if (!s) return json(res, 404, { error: "not found" });
      // Ended in one window while another window (maybe on another machine) still had it open: don't bring it back to life.
      if (s.hidden && parts[3] !== "close") return json(res, 410, { error: "ended" });
      const p = procs.get(s.id);
      if (parts[3] === "send") { if (!String(b.text || "").trim()) return json(res, 400, { error: "empty" }); send(s, String(b.text)); return json(res, 200, { ok: true }); }
      if (parts[3] === "perm") {
        if (!p?.perm || p.perm.request_id !== b.request_id) return json(res, 409, { error: "that question is gone" });
        const r = p.perm; p.perm = null;
        const response = b.allow ? { behavior: "allow", updatedInput: r.input }
          : { behavior: "deny", message: b.answer ? `The user answered: ${b.answer}` : (b.note || "The user said no to this step.") };
        sendLine(p, { type: "control_response", response: { subtype: "success", request_id: r.request_id, response } });
        broadcast(s.id); return json(res, 200, { ok: true });
      }
      if (parts[3] === "close" && s.kind === "api") { s.hidden = true; procs.delete(s.id); saveState(); broadcast(); return json(res, 200, { ok: true }); }
      if (parts[3] === "stop" && s.kind === "api") { if (p?.stop && p.busy) p.stop(); return json(res, 200, { ok: true }); }
      if (parts[3] === "stop" && s.kind === "pipe") { if (p) killTree(p, "SIGINT"); return json(res, 200, { ok: true }); }
      if (parts[3] === "close" && s.kind === "pipe") { if (p) killTree(p); s.hidden = true; saveState(); broadcast(); return json(res, 200, { ok: true }); }
      if (parts[3] === "stop") {
        if (p) sendLine(p, { type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
        return json(res, 200, { ok: true });
      }
      if (parts[3] === "close") {
        if (p) p.child.kill("SIGTERM");
        s.hidden = true; saveState(); broadcast(); return json(res, 200, { ok: true });
      }
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Moonstone on http://localhost:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { for (const p of procs.values()) p.pipe ? killTree(p) : p.child.kill("SIGTERM"); process.exit(0); });
