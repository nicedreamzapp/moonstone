#!/usr/bin/env node
// Moonstone auto-updater. Run it every few minutes from the install folder (a git clone of this repo):
//   node updater.js
// (launchd or cron on a Mac or Linux box, Task Scheduler on Windows; see the README.)
// 1. fetches the remote branch (config autoupdate.remote / autoupdate.branch, default origin / main)
// 2. checks the new server.js with node --check, and asks the running server (/api/version) whether anything is
//    working that a restart would kill: a busy chat, a permission prompt, background work, or activity in the last
//    3 minutes. It waits until all of that is quiet.
// 3. fast-forwards the clone, and if server.js changed, restarts the server with autoupdate.restart (a command
//    as an argv array, e.g. ["launchctl", "kickstart", "-k", "gui/501/com.example.moonstone"]). Open windows reload
//    the page themselves. If the new server does not come up in 60 seconds, the previous commit is put back and
//    that commit is skipped from then on.
// A working tree with local edits is never touched (it logs and waits). An "update.hold" file in the folder pauses it.
// Code only: no model calls, no network beyond git.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const DIR = __dirname;
const LOG = path.join(DIR, "update.log");
const SKIP = path.join(DIR, "update.skip");
const QUIET_SECS = 180;
let CONFIG = {}; try { CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); } catch {}
const AU = CONFIG.autoupdate || {};
const PORT = +(AU.port || process.env.DOCK_PORT || 8899);
const REMOTE = AU.remote || "origin", BRANCH = AU.branch || "main";

function log(m) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200e3) fs.writeFileSync(LOG, fs.readFileSync(LOG, "utf8").split("\n").slice(-300).join("\n"));
    fs.appendFileSync(LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${m}\n`);
  } catch {}
}
const say = m => { try { if (fs.readFileSync(LOG, "utf8").trim().split("\n").pop().endsWith(m)) return; } catch {} log(m); };   // say a waiting note once
const git = (args, opts = {}) => execFileSync(AU.git || "git", args, { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], timeout: 120e3, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...opts }).toString();
const sha = b => crypto.createHash("sha1").update(b).digest("hex").slice(0, 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJSON(p, ms = 6000) {
  return new Promise(done => {
    const r = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: ms }, res => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => { try { done(JSON.parse(b)); } catch { done(null); } });
    });
    r.on("timeout", () => { r.destroy(); done(null); }); r.on("error", () => done(null));
  });
}
function restart() {
  const cmd = Array.isArray(AU.restart) ? AU.restart : null;
  if (!cmd || !cmd.length) return false;
  const r = spawnSync(cmd[0], cmd.slice(1), { timeout: 60e3, windowsHide: true, stdio: "ignore" });
  return r.status === 0;
}
async function waitFor(hash, secs) {
  for (let i = 0; i < secs / 2; i++) { await sleep(2000); const v = await getJSON("/api/version", 4000); if (v && v.server === hash) return true; }
  return false;
}

async function main() {
  if (fs.existsSync(path.join(DIR, "update.hold"))) return;
  try { git(["fetch", "-q", REMOTE, BRANCH]); } catch (e) { log("fetch failed: " + String(e.stderr || e.message).trim().slice(0, 200)); return; }
  const head = git(["rev-parse", "HEAD"]).trim(), want = git(["rev-parse", "FETCH_HEAD"]).trim();
  if (head === want) return;
  if (fs.existsSync(SKIP) && fs.readFileSync(SKIP, "utf8").includes(want)) return;
  try { git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]); } catch { say(`${want.slice(0, 7)}: not a fast-forward from here, leaving it to you`); return; }
  if (git(["status", "--porcelain", "--untracked-files=no"]).trim()) { say(`${want.slice(0, 7)}: this folder has local edits, not updating`); return; }

  const changed = git(["diff", "--name-only", "HEAD", "FETCH_HEAD"]).split("\n").filter(Boolean);
  const serverChanged = changed.includes("server.js");
  if (serverChanged) {
    // check the new server before it goes anywhere near the running one
    const tmp = path.join(DIR, ".server.next.js");
    fs.writeFileSync(tmp, git(["show", "FETCH_HEAD:server.js"], { maxBuffer: 20e6 }));
    const chk = spawnSync(process.execPath, ["--check", tmp], { timeout: 30e3, windowsHide: true });
    fs.rmSync(tmp, { force: true });
    if (chk.status !== 0) { say(`${want.slice(0, 7)}: new server.js fails node --check, not installing`); return; }
    const live = await getJSON("/api/version");
    if (live && (live.busy || live.bg || live.quietSecs < QUIET_SECS)) {
      say(`${want.slice(0, 7)}: waiting for quiet (${live.busy} working, ${live.bg} background, quiet ${live.quietSecs}s)`);
      return;
    }
  }
  git(["merge", "-q", "--ff-only", "FETCH_HEAD"]);
  log(`${head.slice(0, 7)} -> ${want.slice(0, 7)}: ${changed.join(", ")}`);
  if (!serverChanged) return;   // the page reloads itself; nothing else to do
  const hash = sha(fs.readFileSync(path.join(DIR, "server.js")));
  if (!restart()) { log("server.js changed: restart the server to run it (set autoupdate.restart to do this by itself)"); return; }
  if (await waitFor(hash, 60)) { log(`server.js ${hash} live`); return; }
  // did not come up on the new code: put the old commit back and skip this one from now on
  git(["reset", "-q", "--keep", head]);
  fs.appendFileSync(SKIP, want + "\n");
  restart();
  log(`server.js ${hash} did NOT come up, put back ${head.slice(0, 7)} and skipped ${want.slice(0, 7)}`);
}
main().catch(e => log("error: " + (e.stack || e).toString().slice(0, 300)));
