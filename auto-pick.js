// Moonstone Auto model picker. watch only. (a local model should always be running... the chances of
// it being able to complete the task are good"): Auto ACTS. Local first: quick questions, chores, follow-ups, routine and
// bulk work and simple or medium fixes run on the ONE shared local model (or the best working free cloud model);
// Claude takes outward work (customers, public posts in your voice), photos (the local model can't see yet), and any job
// the local model fails (judge()). Hard builds: Claude writes a short plan once, the local model does the steps (flow "plan").
// Naming a model in the message always wins (override()).
// Pure: no files, no network, no clock. Rules come from auto-rules.json (the Rust phone engine reads the same file).
// Unit-tested by test/auto-pick.test.js (incl. the 20 sample requests in test/auto-pick-requests.json).
"use strict";

const TIER_N = { T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 };

function compile(rules) {
  if (rules._re) return rules._re;
  const re = {};
  for (const [k, list] of Object.entries(rules.signals || {})) re[k] = list.map(s => new RegExp(s, "i"));
  Object.defineProperty(rules, "_re", { value: re, enumerable: false });
  return re;
}
const any = (list, t) => (list || []).some(r => r.test(t));

// what the user actually asked: a voice wrapper ("[phone voice] Sam ... said: "...") is unwrapped to the spoken words
function requestText(text) {
  const t = String(text || "");
  const v = /said: "([\s\S]*?)"(?:\s|$)/.exec(t);
  return (/^\[[^\]]*voice\]/.test(t) && v ? v[1] : t).trim();
}

// req: { text, images?: number, ctxTokens?: number, lastTier?: "T1".."T5" }
function signals(req, rules) {
  const re = compile(rules), text = requestText(req.text);
  const words = text.replace(/\[attached file: [^\]]*\]/g, " ").split(/\s+/).filter(Boolean).length;
  return {
    text, words,
    image: (req.images || 0) > 0 || any(re.image, text),
    outward: any(re.outward, text) || !!req.chatOutward,   // the chat itself is customer/public writing ("Send as is" alone says nothing)
    build: any(re.build, text),
    bulk: any(re.bulk, text),
    exact: any(re.exact, text),
    hard: any(re.hard, text),
    ctxTokens: req.ctxTokens || 0,
    lastTier: req.lastTier || null,
    lastKind: req.lastKind || null,
  };
}

// the job's kind, the lowest tier that can do it, and its flow: "run" (one model does it) or "plan" (Claude plans, local does)
function classify(sg, rules) {
  const big = sg.ctxTokens > (rules.ctxBigTokens || 100000);
  //: the ONE explicit trigger for app compile/test/upload. A message that starts with "/ci "
  // goes to Claude, whose turn is told to run that step through free-build. No guessing from the words (that failed 3 reviews).
  if (/^\/ci\s/i.test(sg.text)) return { kind: "ci", min: 4, flow: "ci", why: "/ci: Claude writes the code, free-build runs compile/test/upload on free compute first" };
  if (sg.outward) return { kind: "outward", min: 5, why: "customer or public writing in your voice" };
  // once a chat does customer or public writing, every later turn stays on Claude, any length (kind stays "outward",
  // so it never decays); a 28-word answer to a customer question went to the local model, which invented the reply
  if (sg.lastKind === "outward") return { kind: "outward", min: 5, why: "same chat as writing in your voice" };
  // Builds and design work always go to Claude, and the whole chat stays there (a dashboard card redesign
  // went to MiniMax as a "quick chore" and the chat stuck)
  if (["fix", "plan", "build"].includes(sg.lastKind)) return { kind: "build", min: 5, why: "same chat as a build, stays on Claude" };
  if (sg.image) return { kind: "visual", min: 4, why: sg.build ? "fixing what the picture shows" : "photo task", vision: true };   // photos stay on Claude
  if (sg.build) return { kind: "build", min: 5, why: "build, fix or design work: Claude does it" };
  if (sg.lastTier && sg.words <= (rules.followUpWords || 14)) return { kind: "followup", min: 2, why: "follow-up, local first" };
  if (sg.bulk) return { kind: "bulk", min: 2, why: "routine work with clear steps, local first" };
  if (big) return { kind: "long", min: 2, why: "long chat, local first with the recent turns" };
  return { kind: "small", min: 1, why: "quick question or chore" };
}

const banned = (m, rules) => { const s = [m.id, m.label, m.title, JSON.stringify(m.precision || "")].join(" ").toLowerCase();
  return (rules.never || []).some(w => s.includes(w)); };

// free memory a local model may use right now: what the Mac has free, and never more than the reserved-memory budget
// (a reservation held by another job is never evicted). No reading = no local pick unless the model is already loaded.
function freeGB(state) {
  const vm = state.freeGB != null ? +state.freeGB : null;
  const fg = state.forge && state.forge.budgetGB != null ? +state.forge.budgetGB : null;
  if (vm == null && fg == null) return null;
  return Math.min(vm ?? Infinity, fg ?? Infinity);
}

// every model that could take this job on this machine right now, with the reason it fits
function eligible(job, state, rules) {
  const med = state.medSecs || {}, isSlow = id => med[id] > (rules.slowAnswerSecs || 60);
  const machine = state.machine, loaded = new Set(state.loaded || []), out = new Set(state.out || []);
  const have = state.launchers ? new Set(state.launchers) : null, free = freeGB(state), head = rules.memHeadroomGB ?? 4;
  const res = [];
  for (const m of rules.models || []) {
    if (m.offered === false || banned(m, rules) || m.tools === false) continue;
    if (job.vision && m.where !== "claude" && !m.vision) continue;
    if (m.where === "shared") {   // the ONE shared local model, reachable from every machine 
      const lo = state.localOne;
      if (!lo || !lo.up || lo.parked || lo.loading) continue;
      res.push({ m: { ...m, title: lo.title ? lo.title + (lo.precision ? " " + lo.precision : "") + " (shared)" : m.title }, loaded: true, slow: isSlow(m.id) });
      continue;
    }
    if (m.where === "local") {
      if (!(m.machines || []).includes(machine)) continue;
      const gb = (m.gb || {})[machine];
      if (loaded.has(m.id)) { res.push({ m, loaded: true, slow: isSlow(m.id) }); continue; }
      if (gb == null || free == null || gb + head > free) continue;
      res.push({ m, loaded: false, gb });
    } else if (m.where === "cloud") {
      // `needs` = the launcher that proves this machine has the key (Nemotron rides the OpenRouter key, no button of its own)
      if (out.has(m.provider) || (have && !have.has(m.needs || m.label))) continue;
      if (state.freeOk && state.freeOk[m.id] === false) continue;   // its last real tool call failed (free-check.json)
      res.push({ m, slow: isSlow(m.id) });
    } else if (m.where === "claude") {
      const acct = claudeAccount(state, rules);
      if (!acct) continue;
      res.push({ m, acct });
    }
  }
  return res;
}

// the Claude account Auto would use: lowest 5-hour %, under the governor's pause line (same idea as pickAccount)
function claudeAccount(state, rules) {
  const spent = rules.claudeSpentPct ?? 98;
  // an account with no 5-hour cap (Ultra) is never "spent" on its 5-hour reading, only on its week; that bug told
  // a "Claude accounts are spent" reading while an account still had plenty left
  const five = a => a.nocap ? 0 : Math.round(a.five);
  const ok = (state.accounts || []).filter(a => a.key !== false && !a.held && (a.nocap || a.five != null) && five(a) < spent && !(a.week != null && Math.round(a.week) >= spent));
  ok.sort((a, b) => five(a) - five(b) || (a.week ?? 0) - (b.week ?? 0) || a.n - b.n);
  return ok[0] || null;
}

// score = quality, minus cost, minus energy, plus a small bonus for staying on our own hardware
function score(c) {
  const q = (c.m.grade ?? 6) / 10;
  const cost = (c.m.cost || 0) + (c.m.where === "claude" && c.acct && !c.acct.nocap ? c.acct.five / 200 : 0);
  const energy = c.m.where === "local" && !c.loaded ? 0.1 : 0;
  const own = c.m.where === "local" || c.m.where === "shared" ? 0.15 : 0;   // local first
  // a model whose real Auto answers take over slowAnswerSecs (median, last 7 days) loses to a fast one; fast again = back on top
  const slow = c.slow ? 0.4 : 0;
  return q - cost - energy + own - slow;
}

function costNote(c, rules) {
  if (c.m.where === "shared") return "free, always loaded (shared)";
  if (c.m.where === "local") return c.loaded ? "free, already loaded" : "free, loads on this machine (" + c.gb + " GB fits)";
  if (c.m.where === "cloud") return "free";
  const a = c.acct; if (a.nocap) return "account " + a.n + ", no 5-hour cap"; let s = "account " + a.n + " at " + Math.round(a.five) + "%";
  if (Math.round(a.five) >= (rules.claudeTightPct ?? 90)) s += ", every account is getting tight";
  return s;
}

// Naming a model in the message wins over Auto: "use opus", "on claude", "with qwen", "try it on minimax"
function override(text, rules) {
  const t = requestText(text);
  for (const [want, re] of Object.entries(rules.override || {})) if (new RegExp(re, "i").test(t)) return want;
  return null;
}

// main entry: req (see signals) + live machine state -> { flow, tier, model, title, reason, kind }
// flow: "claude" (the chat's own Claude), "local" / "free" (runs on that model here), "plan" (Claude plans, `model` does the steps),
//       "ci" (a "/ci " message: Claude writes the code, compile/test/upload goes through free-build)
// state: { machine, freeGB, forge: {budgetGB}, loaded, out: [providers], launchers, accounts, localOne: {up,title,precision},
//          freeOk: {model id: bool}, medSecs: {model id: median seconds of finished Auto answers} }
function pick(req, state, rules) {
  const sg = signals(req, rules);
  let job = classify(sg, rules);
  const all = eligible(job, state || {}, rules);
  const T = c => TIER_N[c.m.tier];
  const flowOf = c => c.m.where === "claude" ? "claude" : c.m.where === "cloud" ? "free" : "local";
  const ov = override(req.text, rules);
  if (ov) {   // his pick: that model if it can run now, else say so and use Claude
    const c = all.find(x => x.m.id === ov || (ov === "claude" && x.m.where === "claude") || (ov === "local" && x.m.where === "shared"));
    if (c) return { flow: job.flow === "ci" && c.m.where === "claude" ? "ci" : flowOf(c), tier: c.m.tier, model: c.m.id, title: c.m.title, label: c.m.label, kind: "override",
      reason: "you asked for it", ...(c.acct ? { account: c.acct.n } : {}) };
    job = { kind: "override", min: 4, why: "the model you named isn't available right now" };
  }
  let pool = all.filter(c => T(c) >= job.min), note = "";
  if (job.min >= 4) {
    // a Claude job goes to the lowest Claude tier that fits; when every account is spent, the best free stand-in, said out loud
    pool.sort((a, b) => T(a) - T(b));
    // a /ci job never goes to a stand-in (only a Claude turn gets the free-build note and the never-submit warning)
    if (!pool.length && job.kind === "ci") return { flow: "claude", tier: null, model: null, title: "Claude", kind: job.kind,
      reason: job.why + ", Claude accounts are spent, so it waits for Claude" };
    if (!pool.length) { pool = all.slice().sort((a, b) => score(b) - score(a)); note = "Claude accounts are spent, best stand-in"; }
  } else {
    pool.sort((a, b) => score(b) - score(a) || (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0) || T(a) - T(b));
  }
  const c = pool[0];
  if (!c) return { flow: "claude", tier: null, model: null, title: "nothing available", reason: job.why + ", no model can take it here right now", kind: job.kind };
  let flow = flowOf(c);
  if (job.flow === "plan") flow = flow === "claude" ? "claude" : "plan";
  if (job.flow === "ci" && c.m.where === "claude") flow = "ci";   // a hint on a Claude turn; free-build compiles, tests, uploads
  if (job.vision && c.m.where === "claude") note = note || "the local model can't see pictures yet";
  return { flow, tier: c.m.tier, model: c.m.id, title: c.m.title, label: c.m.label, kind: job.kind,
    reason: [job.why, note, costNote(c, rules)].filter(Boolean).join(", "), ...(c.acct ? { account: c.acct.n } : {}) };
}

// did a local/free run do the job? Code only: exit code, an empty answer, or the model saying it couldn't.
// res: { code, answer, timedOut } -> { ok, why }
function judge(res, rules) {
  const a = String((res && res.answer) || "").trim(), tail = a.slice(-600);
  if (res && res.slowStart) return { ok: false, why: "no tokens in the first few seconds" };
  if (res && res.stalled) return { ok: false, why: "it went quiet" };
  if (res && res.timedOut) return { ok: false, why: "it ran out of time" };
  if (res && res.code !== 0 && res.code != null) return { ok: false, why: "it stopped with an error" };
  if (a.length < 2) return { ok: false, why: "it finished without an answer" };
  for (const re of (rules.failSigns || [])) if (new RegExp(re, "i").test(tail)) return { ok: false, why: "it said it couldn't finish" };
  // a reply that stops mid-step ("Let me use sed directly:") read as done and the chat sat there; it goes to Claude now
  const lastLine = a.split("\n").map(x => x.trim()).filter(Boolean).pop || "";
  for (const re of (rules.unfinishedSigns || [])) if (new RegExp(re, "i").test(lastLine)) return { ok: false, why: "it stopped halfway" };
  return { ok: true, why: "" };
}

// a numbered plan from Claude -> its steps (at most rules.planMaxSteps)
function parsePlan(text, rules) {
  const steps = [];
  for (const ln of String(text || "").split("\n")) {
    const m = /^\s*(?:step\s*)?(\d+)[.):]\s+(.+)$/i.exec(ln);
    if (m) steps.push(m[2].trim());
  }
  return steps.slice(0, (rules && rules.planMaxSteps) || 7);
}

module.exports = { pick, signals, classify, eligible, freeGB, requestText, override, judge, parsePlan, TIER_N };
