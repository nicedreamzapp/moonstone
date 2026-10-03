#!/usr/bin/env node
// Demo mode: serves the real public/index.html against invented data, so you can click around
// the UI (or take screenshots) without Claude Code, models or other machines.
//
//   node tools/demo-server.js            then open http://localhost:8890
//
// Every session, machine and message below is made up. Nothing here reads your disk or starts a process.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.DEMO_PORT || 8890;
const INDEX = path.join(__dirname, "..", "public", "index.html");
const min = n => Date.now() - n * 60e3;
const GB = 1073741824;

const machines = () => [
  { id: "m1", name: "M1", color: "#9b7bff", gpu: 38, mem: { used: 41 * GB, total: 128 * GB }, online: true },
  { id: "m2", name: "M2", color: "#2ee6d2", gpu: 9, mem: { used: 19 * GB, total: 64 * GB }, online: true },
  { id: "pc", name: "PC", color: "#ffb547", gpu: null, mem: { used: 24 * GB, total: 32 * GB }, online: true },
];

const sessions = () => [
  { id: "a1", machine: "m1", kind: "dock", label: "Website", color: "#ffb35c", title: "Fix flaky checkout test", status: "needs",
    last: "The race is between the toast and the cart refetch. Want me to run the spec 20 times to confirm?", updated: min(1), running: true },
  { id: "a2", machine: "m1", kind: "dock", label: "Claude Code", color: "#8b7bff", title: "Refactor auth middleware", status: "answered",
    last: "It does now. The upgrade handler calls requireSession() before the socket is accepted.", updated: min(3), running: true },
  { id: "a3", machine: "m1", kind: "dock", local: true, label: "Gemma 3 27B", color: "#3fd1c0", title: null, status: "idle",
    last: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$ matches the date part of ISO 8601.", updated: min(26), running: true },
  { id: "m2~b1", machine: "m2", kind: "dock", label: "API service", color: "#5aa2ff", title: "Add rate limiting to /v1/search", status: "cooking",
    last: "Adding a token bucket per API key in middleware/rateLimit.ts", updated: min(0.2), running: true },
  { id: "m2~t:demo", machine: "m2", kind: "terminal", label: "Docs site", color: "#ff6fae", title: "Write the v2 migration guide", status: "idle",
    last: "Drafted docs/migrate-v2.md with the three breaking changes and a codemod section.", updated: min(48), live: true },
  { id: "pc~c1", machine: "pc", kind: "dock", label: "Claude Code", color: "#8b7bff", title: "Port build scripts to PowerShell", status: "cooking",
    last: "$ pwsh -File scripts/build.ps1 -Configuration Release", updated: min(0.5), running: true },
  { id: "pc~c2", machine: "pc", kind: "dock", label: "Qwen 2.5 Coder", color: "#a98bff", title: null, status: "idle",
    last: "you: explain what this CMake error means", updated: min(95), running: false },
];

const launchers = () => {
  const L = (machine, id, label, group, extra = {}) => ({ id, label, color: extra.color || "#8b7bff", kind: "claude", group, machine, ...extra });
  return [
    L("m1", "claude-code", "Claude Code", "main"), L("m2", "claude-code", "Claude Code", "main", { best: true }), L("pc", "claude-code", "Claude Code", "main"),
    L("m1", "website", "Website", "cloud", { color: "#ffb35c" }), L("m2", "website", "Website", "cloud", { color: "#ffb35c", best: true }),
    L("m2", "api-service", "API service", "cloud", { color: "#5aa2ff" }),
    L("m1", "gemma", "Gemma 3 27B", "local", { kind: "pipe", color: "#3fd1c0", note: "llama.cpp, runs on this machine" }),
    L("pc", "qwen", "Qwen 2.5 Coder", "local", { kind: "api", color: "#a98bff", note: "llama-server, starts on first message" }),
    L("m1", "activity", "Activity Monitor", "tasks", { kind: "open", color: "#7cc8ff" }),
  ];
};

const WORK_AUTH = [
  { k: "tool", name: "Grep", line: "search “getSession|readSession|sessionFrom” in src/server", out: "src/server/auth.ts:14\nsrc/server/auth.ts:41\nsrc/server/auth.ts:77\nsrc/server/ws.ts:22" },
  { k: "tool", name: "Read", line: "read ~/code/app/src/server/auth.ts", out: "  1  import { verify } from './jwt'\n  2  …" },
  { k: "text", text: "Three code paths read the session: cookie, bearer header and a legacy query param. Folding them into one." },
  { k: "tool", name: "Edit", line: "edit ~/code/app/src/server/auth.ts", out: "ok" },
  { k: "tool", name: "Edit", line: "edit ~/code/app/src/server/routes.ts", out: "ok" },
  { k: "tool", name: "Bash", line: "$ npm test -- auth", out: "PASS  test/auth.spec.ts (24 tests)\nPASS  test/routes.spec.ts (51 tests)" },
];
const WORK_WS = [
  { k: "tool", name: "Read", line: "read ~/code/app/src/server/ws.ts", out: "…" },
  { k: "tool", name: "Edit", line: "edit ~/code/app/src/server/ws.ts", out: "ok" },
  { k: "tool", name: "Bash", line: "$ npm test -- ws", out: "PASS  test/ws.spec.ts (9 tests)" },
];

function detail(id) {
  if (id === "a2") return {
    id, kind: "dock", machine: "m1", label: "Claude Code", color: "#8b7bff", title: "Refactor auth middleware", cwd: "~/code/app", busy: false, perm: null, err: null,
    turns: [
      { i: 0, user: "The auth middleware in src/server/auth.ts reads the session three different ways. Collapse it into one path and keep the tests green.",
        answer: "Done. `requireSession()` is now the single entry point.\n\n- Cookie and bearer token both resolve through `readSession(req)`\n- The legacy `?sid=` query param is gone (nothing in the repo used it)\n- 75 tests pass, no snapshot changes\n\nThe diff is mostly deletions: **-112 / +38** lines.",
        work: null, workN: 5, hasWork: true, open: false, secs: 142 },
      { i: 1, user: "Nice. Does the websocket handler go through it too?",
        answer: "It does now. The upgrade handler calls `requireSession()` before the socket is accepted, so an expired cookie gets a 401 instead of a silent disconnect a minute later.",
        work: null, workN: 3, hasWork: true, open: false, secs: 38 },
    ],
  };
  if (id === "a1") return {
    id, kind: "dock", machine: "m1", label: "Website", color: "#ffb35c", title: "Fix flaky checkout test", cwd: "~/code/website", busy: true, err: null,
    perm: { request_id: "demo-1", tool: "Bash", line: "$ npx playwright test checkout.spec.ts --repeat-each 20", question: null },
    turns: [
      { i: 0, user: "checkout.spec.ts fails about one run in five on CI. Find out why.", answer: null, open: true, secs: null,
        work: [
          { k: "tool", name: "Read", line: "read ~/code/website/tests/checkout.spec.ts", out: "…" },
          { k: "tool", name: "Read", line: "read ~/code/website/src/cart/useCart.ts", out: "…" },
          { k: "text", text: "The test waits for the “Added” toast, then reads the cart badge. The badge updates after a refetch that can land later than the toast." },
          { k: "tool", name: "Edit", line: "edit ~/code/website/tests/checkout.spec.ts", out: "ok" },
        ] },
    ],
  };
  if (id === "a3") return {
    id, kind: "dock", machine: "m1", label: "Gemma 3 27B", color: "#3fd1c0", title: null, cwd: "~/models", busy: false, perm: null, err: null,
    turns: [
      { i: 0, user: "Give me a regex that matches an ISO date like 2026-03-14", answer: "`^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$`\n\nIt checks the month and day ranges but not month lengths, so 2026-02-31 still passes.", work: [], open: false, secs: 4 },
    ],
  };
  const s = sessions().find(x => x.id === id);
  if (!s) return null;
  return { id, kind: s.kind, machine: s.machine, label: s.label, color: s.color, title: s.title, cwd: "~", busy: s.status === "cooking", perm: null, err: null,
    turns: [{ i: 0, user: "(demo session)", answer: s.last, work: [], open: false, secs: 12 }] };
}
const workFor = (id, i) => (id === "a2" ? (+i === 0 ? WORK_AUTH : WORK_WS) : []);

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
let narr = { id: null, at: 0 };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(INDEX));
  }
  if (url.pathname === "/api/state") return json(res, 200, { machines: machines(), sessions: sessions(), launchers: launchers() });
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n"); res.write(`data: ${JSON.stringify({ t: Date.now(), v: 1, focus: { id: null, at: 0 } })}\n\n`);
    const t = setInterval(() => res.write(": ping\n\n"), 15000); req.on("close", () => clearInterval(t)); return;
  }
  if (url.pathname === "/api/narrator") {
    if (req.method === "POST") { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { try { narr = { id: JSON.parse(b).id, at: Date.now() }; } catch {} json(res, 200, narr); }); return; }
    return json(res, 200, narr);
  }
  if (parts[0] === "api" && parts[1] === "session" && parts[2] && parts[3] === "work") return json(res, 200, { work: workFor(parts[2], parts[4]) });
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[2]) { const d = detail(parts[2]); return d ? json(res, 200, d) : json(res, 404, { error: "not found" }); }
  if (req.method === "POST" && url.pathname === "/api/dictate") return json(res, 409, { error: "demo mode" });
  if (req.method === "POST" && url.pathname === "/api/launch") return json(res, 200, { id: "a2" });
  if (req.method === "POST") return json(res, 200, { ok: true });
  res.writeHead(404); res.end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`Moonstone demo on http://localhost:${PORT}`));
