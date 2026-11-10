#!/usr/bin/env node
// Demo mode: serves the real public/index.html against invented data, so you can click around
// the UI (or take screenshots) without Claude Code, models or other machines.
//
//   node tools/demo-server.js            then open http://localhost:8890
//
// Every session, machine, account and message below is made up. Nothing here reads your disk
// (besides public/index.html) or starts a process.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.DEMO_PORT || 8890;
const INDEX = path.join(__dirname, "..", "public", "index.html");
const min = n => Date.now() - n * 60e3;
const inMin = n => Date.now() + n * 60e3;
const sec = n => Math.round(Date.now() / 1000 - n);   // job timestamps are in seconds
const GB = 1073741824;

// Machine names and colours come from the state, like the real server sends them.
function page() { return fs.readFileSync(INDEX, "utf8"); }

const machines = () => [
  { id: "m1", name: "M1", gpu: 38, mem: { used: 41 * GB, total: 128 * GB }, online: true,
    phone: { ok: true, at: Date.now(), asleep: true } },
  { id: "m2", name: "M2", gpu: 9, mem: { used: 19 * GB, total: 64 * GB }, online: true },
  { id: "pc", name: "PC", gpu: null, mem: { used: 24 * GB, total: 32 * GB }, online: true },
];

const SAFE = { safe: true };
const sessions = () => [
  // M1
  { id: "a1", machine: "m1", kind: "dock", label: "Website", title: "Fix flaky checkout test", subject: "Fix flaky checkout test",
    status: "needs", updated: min(1), running: true, acctOn: 1 },
  { id: "a2", machine: "m1", kind: "dock", label: "Claude Code", subject: "Refactor auth middleware", status: "answered",
    close: SAFE, updated: min(3), running: true, acctOn: 1, model: "opus" },
  { id: "a4", machine: "m1", kind: "dock", label: "API service", subject: "Add rate limiting to /v1/search", status: "cooking",
    watch: { state: "running a tool" }, eta_start: min(9), eta_end: inMin(6), eta_src: "chat", updated: min(0.2), running: true, acctOn: 2 },
  { id: "a3", machine: "m1", kind: "dock", local: true, label: "Gemma 4", subject: "ISO date regex", status: "idle", close: SAFE, updated: min(26), running: true },
  // M2
  { id: "m2~b1", machine: "m2", kind: "dock", label: "Docs site", subject: "Write the v2 migration guide", status: "yourturn",
    ask: "Publish the guide now, or wait for the v2.1 tag?", updated: min(2), running: true, acctOn: 1 },
  { id: "m2~b2", machine: "m2", kind: "dock", label: "Release", subject: "Changelog for v2.1", status: "idle", bg: 2,
    eta_start: min(14), eta_end: inMin(11), eta_src: "background", close: { safe: false, why: "2 background jobs" }, updated: min(4), running: true, acctOn: 2 },
  { id: "m2~d1", machine: "m2", kind: "dock", label: "Docs site", subject: "Fix broken anchor links", status: "idle", doneAt: min(70), updated: min(70) },
  { id: "m2~d2", machine: "m2", kind: "dock", label: "Website", subject: "Compress hero images", status: "idle", doneAt: min(150), updated: min(150) },
  // PC
  { id: "pc~c1", machine: "pc", kind: "dock", label: "Claude Code", subject: "Port build scripts to PowerShell", status: "cooking",
    watch: { state: "thinking" }, eta_start: min(5), eta_end: inMin(9), eta_src: "chat", updated: min(0.5), running: true, acctOn: 1 },
  { id: "pc~c2", machine: "pc", kind: "dock", local: true, label: "Qwen 2.5 Coder", subject: "Explain a CMake error", status: "idle", close: { safe: false, why: "waiting on the build log" }, updated: min(95), running: false },
  // started from the phone, running on M1
  { id: "p1", machine: "m1", kind: "dock", device: "phone", phoneAt: min(8), label: "Claude Code", subject: "Summarize today's merged PRs",
    status: "answered", close: SAFE, updated: min(8), running: true, acctOn: 2 },
  { id: "p2", machine: "m1", kind: "dock", device: "phone", phoneAt: min(200), label: "Claude Code", subject: "Weekend on-call checklist",
    status: "idle", doneAt: min(190), updated: min(190) },
];

const launchers = () => {
  const L = (machine, id, label, group, extra = {}) => ({ id, label, color: extra.color || "#8b7bff", kind: "claude", group, machine, ...extra });
  return [
    L("m1", "claude", "Claude Code", "main"), L("m2", "claude", "Claude Code", "main", { best: true }), L("pc", "claude", "Claude Code", "main"),
    L("m1", "gemma", "Gemma 4", "local", { kind: "pipe", color: "#3fd1c0", note: "llama.cpp, runs on this machine" }),
    L("pc", "qwen", "Qwen 2.5 Coder", "local", { kind: "api", color: "#a98bff", note: "llama-server, starts on first message" }),
    L("m1", "activity", "Activity Monitor", "tasks", { kind: "open", color: "#7cc8ff" }),
    L("m2", "notes", "Notes", "tasks", { kind: "open", color: "#ffd166" }),
  ];
};

// two invented Claude accounts; Auto puts new chats on the less-used one
const ACCOUNT = { active: 1, mode: "auto", has: { 1: true, 2: true },
  list: { 1: { name: "work", plan: "Max" }, 2: { name: "personal", plan: "Pro" } },
  emails: { 1: "work@example.com", 2: "personal@example.com" }, pct: { 1: 22, 2: 58 } };
function usage(n) {
  const p = +n === 2 ? [58, 71] : [22, 41];
  const five = { utilization: p[0], resets_at: new Date(inMin(134)).toISOString() };
  const week = { utilization: p[1], resets_at: new Date(inMin(60 * 52)).toISOString() };
  return { account: +n || 1, at: Date.now(), five, week,
    limits: [{ kind: "session", percent: p[0], resets_at: five.resets_at }, { kind: "weekly_all", percent: p[1], resets_at: week.resets_at }] };
}

const REQS_A2 = { has: true, items: [
  { text: "Collapse the three session readers into one", status: "done", model: "Opus", tok: 41200 },
  { text: "Keep every test green", status: "done", model: "Opus", tok: 3100 },
  { text: "Route the websocket upgrade through it too", status: "done", model: "Opus", tok: 12800 },
  { text: "Add a test for the expired cookie case", status: "done", model: "Opus", tok: 9400 },
], topics: [
  { i: 0, title: "One session entry point", ts: min(42) },
  { i: 1, title: "Websocket upgrade auth", ts: min(20) },
  { i: 2, title: "Expired cookie test", ts: min(4) },
] };

function detail(id) {
  const s = sessions().find(x => x.id === id);
  const base = s ? { id, kind: s.kind, machine: s.machine, label: s.label, subject: s.subject, device: s.device, local: s.local,
    acctOn: s.acctOn, acctAuto: true, perm: null, err: null, busy: false } : null;
  if (id === "a2") return { ...base, cwd: "~/code/app",
    ctx: { pct: 31, used: 62000, max: 200000, model: "opus" }, fresh: { offer: true }, reqs: REQS_A2,
    turns: [
      { i: 0, user: "The auth middleware in src/server/auth.ts reads the session three different ways. Collapse it into one path and keep the tests green.",
        answer: "Done. `requireSession()` is now the single entry point.\n\n- Cookie and bearer token both resolve through `readSession(req)`\n- The legacy `?sid=` query param is gone (nothing in the repo used it)\n- 75 tests pass, no snapshot changes\n\nThe diff is mostly deletions: **-112 / +38** lines.",
        tok: 41200, secs: 142 },
      { i: 1, user: "Nice. Does the websocket handler go through it too?",
        answer: "It does now. The upgrade handler calls `requireSession()` before the socket is accepted, so an expired cookie gets a 401 instead of a silent disconnect a minute later.",
        tok: 12800, secs: 38 },
      { i: 2, user: "Great. Now add a test for the expired cookie case.",
        answer: "Added `test/ws.expired.spec.ts`: it signs a cookie that expired a minute ago, opens the socket and expects a 401 before the upgrade. All 76 tests pass.\n\nCLOSE: safe",
        tok: 9400, secs: 51 },
    ] };
  if (id === "a1") return { ...base, cwd: "~/code/website", busy: true, liveTok: 8214,
    ctx: { pct: 18, used: 36000, max: 200000, model: "sonnet" },
    perm: { request_id: "demo-1", tool: "Bash", line: "$ npx playwright test checkout.spec.ts --repeat-each 20", question: null },
    reqs: { has: true, items: [{ text: "Find out why checkout.spec.ts fails on CI", status: "open" }], topics: [{ i: 0, title: "Flaky checkout test", ts: min(6) }] },
    turns: [
      { i: 0, user: "checkout.spec.ts fails about one run in five on CI. Find out why.", open: true,
        work: [
          { k: "tool", name: "Read", line: "read tests/checkout.spec.ts" },
          { k: "text", text: "The test waits for the “Added” toast, then reads the cart badge. The badge updates after a refetch that can land later than the toast, so the assertion sometimes sees the old count." },
          { k: "tool", name: "Edit", line: "edit tests/checkout.spec.ts" },
          { k: "text", text: "Now it waits for the badge itself. Running the spec 20 times in a row to prove it holds." },
        ] },
    ] };
  if (id === "m2~b2") return { ...base, cwd: "~/code/app", busy: true, liveTok: 18432,
    ctx: { pct: 44, used: 88000, max: 200000, model: "sonnet" },
    reqs: { has: true, items: [
      { text: "Draft the v2.1 changelog from merged PRs", status: "done", model: "Sonnet", tok: 22100 },
      { text: "Group entries by area", status: "done", model: "Sonnet", tok: 4300 },
      { text: "Rebuild the docs site with the new pages", status: "open" },
      { text: "Link every entry to its PR", status: "open" },
    ], topics: [{ i: 0, title: "v2.1 changelog", ts: min(14) }] },
    jobs: [
      { kind: "agent", label: "Link 42 changelog entries to their PRs", model: "haiku", start: sec(380), total: 42, done: 27,
        step: "Entry 28: retry budget for uploads", stepAt: sec(4) },
      { kind: "bash", label: "npm run build:docs", start: sec(240), eta_end: sec(-420), step: "Rendering page 74 of 118", stepAt: sec(2) },
    ],
    turns: [
      { i: 0, user: "Write the v2.1 changelog from everything merged since v2.0, grouped by area, then rebuild the docs site.",
        answer: "Drafted `CHANGELOG.md` for v2.1: 42 entries in five groups (API, Uploads, Auth, Docs, Tooling).\n\nTwo things are still running in the background: one agent is linking each entry to its PR, and the docs build is rendering the new pages. I'll post the preview link when both land, about 11 minutes.",
        tok: 26400, secs: 96 },
      { i: 1, user: "Also call out the breaking change in Auth at the top.", open: true,
        work: [{ k: "text", text: "Moving the `?sid=` removal into a **Breaking changes** section at the top, with the one-line migration." }] },
    ] };
  if (id === "m2~b1") return { ...base, cwd: "~/code/docs",
    ask: "Publish the guide now, or wait for the v2.1 tag?",
    ctx: { pct: 27, used: 54000, max: 200000, model: "opus" },
    reqs: { has: true, items: [
      { text: "Write the v2 migration guide", status: "done", model: "Opus", tok: 30800 },
      { text: "Add a codemod section", status: "done", model: "Opus", tok: 7200 },
      { text: "Publish it", status: "open" },
    ], topics: [{ i: 0, title: "v2 migration guide", ts: min(30) }, { i: 1, title: "Codemod section", ts: min(3) }] },
    turns: [
      { i: 0, user: "Write the v2 migration guide: the three breaking changes, and a codemod section.",
        answer: "Drafted `docs/migrate-v2.md` with the three breaking changes, a before/after for each, and a codemod section that rewrites the old imports in one command.",
        tok: 30800, secs: 120 },
      { i: 1, user: "Looks good. Ship it.",
        answer: "The guide is ready and the preview builds clean. The release itself is still on v2.0, so readers would see v2.1 steps a day early.\n\nPublish the guide now, or wait for the v2.1 tag?\n\nOptions: Publish now | Wait for the tag",
        tok: 2100, secs: 14 },
    ] };
  if (id === "p1") return { ...base, cwd: "~/code/app",
    ctx: { pct: 9, used: 18000, max: 200000, model: "sonnet" },
    reqs: { has: true, items: [{ text: "Summarize today's merged PRs", status: "done", model: "Sonnet", tok: 6100 }], topics: [{ i: 0, title: "Today's PRs", ts: min(8) }] },
    turns: [
      { i: 0, user: "What got merged today?",
        answer: "Five PRs landed today:\n\n- **Rate limiting** for /v1/search (token bucket per key)\n- **Upload retries** now back off and give up after 5 tries\n- **Docs**: v2 migration guide draft\n- Two dependency bumps, no code changes\n\nNothing is waiting on review.\n\nCLOSE: safe",
        tok: 6100, secs: 19 },
    ] };
  if (id === "a3") return { ...base, cwd: "~/models",
    turns: [
      { i: 0, user: "Give me a regex that matches an ISO date like 2026-03-14", answer: "`^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$`\n\nIt checks the month and day ranges but not month lengths, so 2026-02-31 still passes.", secs: 4 },
    ] };
  if (!s) return null;
  return { ...base, busy: s.status === "cooking", ctx: s.local ? null : { pct: 12, used: 24000, max: 200000, model: "sonnet" },
    reqs: { has: true, items: [{ text: s.subject, status: s.status === "cooking" ? "open" : "done" }], topics: [] },
    turns: [{ i: 0, user: s.subject, answer: s.status === "cooking" ? null : "Done.", open: s.status === "cooking",
      work: s.status === "cooking" ? [{ k: "text", text: "Working through it now." }] : [], tok: 3200, secs: 12 }] };
}

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
let narr = { id: null, at: 0 };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page());
  }
  if (url.pathname === "/api/state") return json(res, 200, { machines: machines(), sessions: sessions(), launchers: launchers(), account: ACCOUNT });
  if (url.pathname === "/api/usage") return json(res, 200, usage(url.searchParams.get("acct") || 1));
  if (url.pathname === "/api/clients") return json(res, 200, { ok: true });
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n"); res.write(`data: ${JSON.stringify({ t: Date.now(), v: 1, focus: { id: null, at: 0 } })}\n\n`);
    const t = setInterval(() => res.write(": ping\n\n"), 15000); req.on("close", () => clearInterval(t)); return;
  }
  if (url.pathname === "/api/narrator") {
    if (req.method === "POST") { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { try { narr = { id: JSON.parse(b).id, at: Date.now() }; } catch {} json(res, 200, narr); }); return; }
    return json(res, 200, narr);
  }
  if (parts[0] === "api" && parts[1] === "session" && parts[2] && parts[3] === "work") return json(res, 200, { work: [] });
  if (parts[0] === "api" && parts[1] === "session" && parts[2] && parts[3] === "reqs") { const d = detail(parts[2]); return json(res, 200, { reqs: (d && d.reqs) || { has: true, items: [] } }); }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[2]) { const d = detail(parts[2]); return d ? json(res, 200, d) : json(res, 404, { error: "not found" }); }
  if (req.method === "POST" && ["/api/dictate", "/api/stt", "/api/tts"].includes(url.pathname)) return json(res, 409, { error: "demo mode" });
  if (req.method === "POST" && url.pathname === "/api/account") return json(res, 200, { ok: true, ...ACCOUNT });
  if (req.method === "POST" && url.pathname === "/api/launch") return json(res, 200, { id: "a2" });
  if (req.method === "POST") return json(res, 200, { ok: true });
  res.writeHead(404); res.end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`Moonstone demo on http://localhost:${PORT}`));
