#!/usr/bin/env node
// chat-send: one Moonstone chat tells another something, on any machine.
//   chat-send <id> "message"        send (ids look like m1~c84627d9, pc~t:05785fee)
//   chat-send <id> -                read the message from stdin (long text, quotes, code)
//   chat-send <id> "msg" --wait 60  also wait up to 60 s for the read receipt
//   chat-send status [message id]   receipts for what this chat sent (queued / delivered / read)
//   chat-send inbox                 the last messages other chats sent to this chat
//   chat-send whoami | list         this chat's id | every live chat and its id
// Talks only to this machine's dock (127.0.0.1, MOONSTONE_PORT or 8899); the dock carries it to the
// other machine over the tunnels it already has. The sender is found from Claude Code's own session id.
// Put a `chat-send` wrapper on your PATH (see the README), e.g. in ~/.local/bin:
//   printf '#!/bin/sh\nexec node "%s" "$@"\n' "$PWD/tools/chat-send.js" > ~/.local/bin/chat-send && chmod +x ~/.local/bin/chat-send
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const PORT = +(process.env.MOONSTONE_PORT || process.env.DOCK_PORT || 8899);

function session() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  const pid = process.env.CLAUDE_PID;   // older Claude Code: its pid file names the session
  if (pid) try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "sessions", pid + ".json"), "utf8")).sessionId; } catch {}
  return "";
}
function call(method, p, data) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, timeout: 15000,
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-dock": "1" } }, res => {
      let b = ""; res.on("data", c => (b += c)); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = { error: b || "HTTP " + res.statusCode }; } resolve({ code: res.statusCode, body: j }); });
    });
    r.on("timeout", () => r.destroy(new Error("Moonstone didn't answer")));
    r.on("error", e => reject(new Error("can't reach Moonstone on this machine (port " + PORT + "): " + e.message)));
    if (data) r.write(JSON.stringify(data)); r.end();
  });
}
const t = ms => (ms ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
function line(v) {
  if (v.error) return `${v.mid || ""} ${v.error}`.trim();
  const st = v.state === "read" ? `read ${t(v.readAt)}` : v.state === "delivered" ? `delivered ${t(v.deliveredAt)} (${v.via === "wake" ? "woke it as a new turn" : "added to its next turn"})` : v.state;
  return `${v.mid} -> ${v.to}${v.toLabel ? " (" + v.toLabel + ")" : ""}: ${st}${v.note ? " - " + v.note : ""}`;
}
const readStdin = () => new Promise(ok => { let b = ""; process.stdin.on("data", c => (b += c)); process.stdin.on("end", () => ok(b)); });
const q = s => encodeURIComponent(s);

async function main() {
  const a = process.argv.slice(2), sid = session();
  let wait = 0; const wi = a.indexOf("--wait"); if (wi >= 0) { wait = +a[wi + 1] || 60; a.splice(wi, 2); }
  const cmd = a[0];
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 9).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  if (cmd === "whoami") { const r = await call("GET", "/api/chat/whoami?session=" + q(sid)); console.log(r.body.id ? `${r.body.id} (${r.body.label})` : "not a Moonstone chat (no session found)"); return; }
  if (cmd === "list") {
    const r = await call("GET", "/api/state"), machine = (r.body.machines || [])[0]?.id;
    for (const s of r.body.sessions || []) {
      let id = String(s.id).includes("~") ? s.id : machine + "~" + s.id; id = id.replace(/~t:([0-9a-f]{8})[0-9a-f-]*$/, "~t:$1");
      console.log(`${id}  ${s.status}  ${s.label}${s.title ? ": " + s.title : ""}`);
    }
    return;
  }
  if (cmd === "status") {
    if (a[1]) { const r = await call("GET", "/api/chat/status?mid=" + q(a[1])); console.log(line(r.body)); return; }
    const r = await call("GET", "/api/chat/sent?session=" + q(sid));
    if (!r.body.sent?.length) return console.log("nothing sent from this chat yet");
    for (const v of r.body.sent) console.log(line(v) + (v.text ? `  "${v.text}"` : ""));
    return;
  }
  if (cmd === "inbox") {
    const r = await call("GET", "/api/chat/inbox?session=" + q(sid));
    if (!r.body.inbox?.length) return console.log("no messages for this chat");
    for (const m of r.body.inbox) console.log(`${t(m.at)} from ${m.from} (${m.fromLabel}): ${m.text}`);
    return;
  }
  let text = a.slice(1).join(" ");
  if (text === "-") text = await readStdin();
  if (!text.trim()) { console.error('usage: chat-send <id> "message"'); process.exit(2); }
  const r = await call("POST", "/api/chat/send", { to: cmd, text, session: sid });
  if (r.code === 404 && r.body.error === "not found") { console.error("not sent: this machine's Moonstone is an older version without chat messages; update it and try again"); process.exit(1); }
  if (r.code !== 200) { console.error("not sent: " + (r.body.error || "HTTP " + r.code)); process.exit(1); }
  let v = r.body; const from = v.from;
  // give it a moment to land, then report the receipt (or keep waiting for "read" with --wait)
  const until = Date.now() + Math.max(2500, wait * 1000);
  while (Date.now() < until && v.state !== "read" && !(wait === 0 && v.state === "delivered")) {
    await new Promise(z => setTimeout(z, 1200));
    const s = await call("GET", "/api/chat/status?mid=" + q(v.mid)).catch(() => null); if (s && s.code === 200 && !s.body.error) v = s.body;
  }
  console.log(`sent as ${from}. ` + line(v) + (v.state === "read" ? "" : `\ncheck later: chat-send status ${v.mid}`));
}
main().catch(e => { console.error("not sent: " + e.message); process.exit(1); });
