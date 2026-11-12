// node test/auto-pick.test.js   (Auto model picker: watch only, acts; pure, no dock started)
"use strict";
const assert = require("assert"), path = require("path");
const { pick, freeGB, requestText, judge, parsePlan, override } = require(path.join(__dirname, "..", "auto-pick.js"));
const rules = require(path.join(__dirname, "..", "auto-rules.json"));
let n = 0; const ok = (name, got, want) => { assert.deepStrictEqual(got, want, name); n++; console.log("ok   " + name); };
const ACC = [{ n: 1, five: 30, week: 40 }, { n: 2, five: 12, week: 30 }];
const LO = { up: true, title: "Qwen 3.6 35B", precision: "bf16", parked: "" };
const MAIN = { machine: "main", freeGB: 70, forge: { budgetGB: 80 }, loaded: [], out: [], accounts: ACC, localOne: LO };
const NOLO = { ...MAIN, localOne: null };
const P = (text, st = MAIN, extra = {}) => pick({ text, ...extra }, st, rules);

// local first, Claude for outward work, photos and hard-build plans
ok("quick question -> the shared local model", P("what time is it in Tokyo").model, "local-shared");
ok("...and its flow is local", P("what time is it in Tokyo").flow, "local");
ok("the chat shows the exact model and precision", P("what time is it in Tokyo").title, "Qwen 3.6 35B bf16 (shared)");
ok("routine batch -> local now (was Sonnet)", P("rename all the songs in the folder").flow, "local");
ok("fix -> Claude ", P("fix the dock crash").flow, "claude");
ok("design change -> Claude ", P("I want to change the look of the agent cards on status dashboard").flow, "claude");
ok("short follow-up in a Claude job -> local first", P("ok now do the other one", MAIN, { lastTier: "T5" }).flow, "local");
ok("follow-up on personal-voice writing stays on Claude", P("make it shorter", MAIN, { lastTier: "T5", lastKind: "outward" }).flow, "claude");
ok("a long answer in a customer-email chat stays on Claude", P("On first use, Thanks for the question. On first use I just run the device through a short test session. There is no need to do anything special before that if it is not necessary", MAIN, { lastTier: "T5", lastKind: "outward" }).flow, "claude");
ok("starting an email run is Claude work", P("Let’s do emails starting with the easiest ones", MAIN).flow, "claude");
ok("customer email -> Claude Opus", P("reply to the customer about the warranty").model, "opus");
ok("hard build -> Claude ", P("build a new page for the shop that lists every coil").flow, "claude");
ok("photo -> Claude (local can't see yet)", P("[attached file: /u/a.png] what color is this").flow, "claude");
ok("photo reason says why", /can't see pictures/.test(P("[attached file: /u/a.png] what color is this").reason), true);
ok("Fable is never picked", rules.models.some(m => /fable/i.test(m.id)), false);
ok("no 4-bit model in any tier", rules.models.some(m => /4bit|4-bit/i.test(JSON.stringify(m))), false);
ok("no Grok in any tier", rules.models.some(m => /grok/i.test(JSON.stringify(m))), false);
ok("Auto never starts a second local model", rules.models.filter(m => m.where === "local" && m.offered !== false && !(m.machines || []).includes("phone")).length, 0);

// the shared model's state
ok("local model parked (overflow) -> best free cloud", P("what time is it in Tokyo", { ...MAIN, localOne: { ...LO, parked: "other job" } }).model, "nemotron-vl");
ok("local model unreachable -> best free cloud", P("what time is it in Tokyo", NOLO).flow, "free");
ok("loading counts as not ready", P("what time is it in Tokyo", { ...MAIN, localOne: { ...LO, loading: true } }).flow, "free");
ok("eligible from a second machine too (it's on the network)", P("what time is it", { ...MAIN, machine: "small" }).model, "local-shared");
ok("eligible from a third machine too", P("what time is it", { ...MAIN, machine: "other" }).model, "local-shared");
ok("phone -> on-device Qwen", P("what time is it", { machine: "phone", freeGB: 8, accounts: ACC }).model, "qwen35-2b");

// free cloud + governor
ok("a free model whose tool-call check failed is skipped", P("what time is it", { ...NOLO, freeOk: { "nemotron-vl": false } }).model !== "nemotron-vl", true);
ok("a provider that is out is skipped", P("what time is it", { ...NOLO, out: ["openrouter"] }).model !== "nemotron-vl", true);
ok("no local, no free cloud -> Claude", P("what time is it", { ...NOLO, out: ["nvidia", "gemini", "openrouter"] }).flow, "claude");
ok("Opus uses the least-used account", P("reply to the customer").account, 2);
ok("every account past 90% -> the reason says so", /getting tight/.test(P("post on linkedin about it", { ...MAIN, accounts: [{ n: 1, five: 93 }, { n: 2, five: 95 }] }).reason), true);
ok("every account spent -> best stand-in, said out loud", /spent/.test(P("post on linkedin about it", { ...MAIN, accounts: [{ n: 1, five: 99 }, { n: 2, five: 98 }] }).reason), true);
ok("voice wrapper is unwrapped", requestText('[phone voice] Sam pressed the Action Button and said: "what time is it" Do it on the phone'), "what time is it");

// The user's pick always wins
ok("'use opus' -> Opus even for a chore", P("use opus and tell me the time").model, "opus");
ok("'with claude' -> Claude", P("check the logs with claude").flow, "claude");
ok("'use qwen' -> the local model even for outward work", P("use qwen to draft a reply to the customer").model, "local-shared");
ok("'use nemotron' -> Nemotron", P("use nemotron for this one: list the files").model, "nemotron-vl");
ok("named model not available -> Claude, said so", /isn't available/.test(P("use qwen for this", NOLO).reason), true);
ok("plain text names no model", override("what's the weather", rules), null);

// the escalation check (code only)
ok("good answer passes", judge({ code: 0, answer: "Done. 3 files renamed." }, rules).ok, true);
ok("non-zero exit escalates", judge({ code: 1, answer: "partial" }, rules).ok, false);
ok("empty answer escalates", judge({ code: 0, answer: " " }, rules).ok, false);
ok("timeout escalates", judge({ code: 0, answer: "x", timedOut: true }, rules).ok, false);
ok("'I couldn't' escalates", judge({ code: 0, answer: "I looked, but I couldn't find the config file." }, rules).ok, false);
ok("hitting the step limit escalates", judge({ code: 0, answer: "Stopped: reached max steps" }, rules).ok, false);

// plans
ok("plan steps are read from a numbered list", parsePlan("Plan:\n1. Read server.js\n2) Add the route\nStep 3: Test it\nnotes", rules), ["Read server.js", "Add the route", "Test it"]);
ok("plans are capped", parsePlan([1,2,3,4,5,6,7,8,9].map(i => i + ". s" + i).join("\n"), rules).length, rules.planMaxSteps);

// free compute first: ONE explicit trigger, "/ci ", no guessing from the words
const CI = "/ci fix the crash in the camera view then upload the build to testflight";
ok("/ci -> ci flow", P(CI).flow, "ci");
ok("/ci -> Claude writes the code", P(CI).model, "sonnet");
ok("/ci beats outward words", P("/ci build the customer email screen").flow, "ci");
ok("/ci with a named Claude model keeps the ci flow", P("/ci use opus to upload the build").flow, "ci");
for (const t of ["upload 1.0 to testflight", "send the build log", "summarize this log\na\nb\nc", "xcodebuild archive my app", "/cinema night", "ci the build"])
  ok(`"${t.split("\n")[0]}" is not a ci job`, P(t).flow !== "ci", true);
const SPENT = { ...MAIN, accounts: [{ n: 1, five: 99 }] };
ok("/ci with every account spent -> waits for Claude, no stand-in", P(CI, SPENT).model, null);
ok("...and says why", /spent/.test(P(CI, SPENT).reason), true);
// the notes Auto puts in front of the user's words are cut out exactly (markers, not "]" + blank line)
const SRC = require("fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const strip = new Function(SRC.match(/const NOTE_OPEN = [^\n]*\n/)[0] + SRC.match(/function autoNoteWrap[^\n]*\n/)[0] +
  SRC.match(/function autoStripNotes[\s\S]*?\n}\n/)[0] + "return { autoNoteWrap, autoStripNotes };")();
const tricky = strip.autoNoteWrap("[Auto handled these:\nResult: see [the doc](https://x.y/a) and [1, 2]\n\n[\"a\"]\n\nmore]");
ok("note with a markdown link and a JSON array + blank line is cut exactly", strip.autoStripNotes(tricky + "upload the build"), "upload the build");
ok("two notes in a row are both cut", strip.autoStripNotes(tricky + strip.autoNoteWrap("[Auto: app compile/test/upload work.]") + "go"), "go");
ok("The user's own brackets are kept", strip.autoStripNotes("[1, 2]\n\nkeep this"), "[1, 2]\n\nkeep this");
ok("older notes (before the markers) are still cut", strip.autoStripNotes("[Auto handled these x]\n\nhi"), "hi");

// "/ci " is always cut from what Claude gets (server.js send), on every machine
const ciLine = SRC.match(/\n\s*if \(CI_ON && opts\.user && \/\^\\\/ci\\s\/i[^\n]*\n/);
ok("send cuts the /ci prefix", !!ciLine, true);
const cut = new Function("opts", "text", "const CI_ON = true;" + ciLine[0] + "return text;");
ok("...'/ci upload my app' reaches Claude as 'upload my app'", cut({ user: true }, "/ci upload my app"), "upload my app");
ok("...other text is untouched", cut({ user: true }, "/cinema night"), "/cinema night");
const bare = SRC.match(/\n\s*if \(CI_ON && opts\.user && \/\^\\\/ci\\s\*\$\/i[^\n]*\n/);
ok("a bare /ci sends nothing", !!bare, true);
const bareFn = new Function("opts", "text", "s", "chatNote", "broadcast", "const CI_ON = true;" + bare[0] + "return 'sent';");
for (const t of ["/ci", "/ci  ", "/CI\n"]) {
  const notes = new Map();
  ok(`..."${t.trim()}" sends nothing`, bareFn({ user: true }, t, { id: "c1" }, notes, () => {}), undefined);
  ok(`...and shows "add what to build after /ci"`, /after \/ci/i.test((notes.get("c1") || {}).text || ""), true);
}
ok("...'/ci upload' still goes", bareFn({ user: true }, "/ci upload", { id: "c1" }, new Map(), () => {}), "sent");
ok("the note reaches the chat view", /note: \(n => n && Date\.now\(\) - n\.at < 60e3/.test(SRC) && /d\.note\?`<div class="note">/.test(require("fs").readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")), true);
// "/ci X" and "X" never share a cached Auto pick; the label still finds a /ci turn by the user bubble ("X")
const keyLines = SRC.match(/\n\s*const ci = \/\^\\\/ci[^\n]*\n\s*const k = [^\n]*\n/)[0].replace(/if \(autoSeen\.has\(k\)\)[^\n]*/, "");
const keyOf = new Function("s", "t", "autoKey", keyLines + "return k;");
const H = x => "h(" + x + ")";
ok("/ci X and X get different pick keys", keyOf({ id: "c1" }, "/ci upload my app", H) !== keyOf({ id: "c1" }, "upload my app", H), true);
ok("...the /ci key is ci: + the bubble's hash", keyOf({ id: "c1" }, "/ci upload my app", H), "c1|ci:h(upload my app)");
const autoOfSrc = SRC.match(/function autoOf\(id, user\)[^\n]*\n/)[0];
const autoOfFn = (seen) => new Function("autoSeen", "autoKey", autoOfSrc + "return autoOf;")(seen, H);
ok("the label finds a /ci turn from the user bubble", autoOfFn(new Map([["c1|ci:h(upload my app)", { acted: true, title: "Sonnet", reason: "r" }]]))("c1", "upload my app").title, "Sonnet");
ok("...a plain turn's own pick wins over a /ci one", autoOfFn(new Map([["c1|h(x)", { acted: true, title: "Qwen", reason: "r" }], ["c1|ci:h(x)", { acted: true, title: "Sonnet", reason: "r" }]]))("c1", "x").title, "Qwen");

// the 20 sample requests (expect: cheap = local or free, plan, claude; "was" = the tier, changed on with "why")
const rec = require(path.join(__dirname, "auto-pick-requests.json"));
let hit = 0; const miss = [];
for (const r of rec.requests) {
  const got = pick({ text: r.text, lastTier: r.lastTier }, { ...rec.state, localOne: LO }, rules);
  const good = r.expect === "cheap" ? ["local", "free"].includes(got.flow) : got.flow === r.expect;
  if (good) hit++; else miss.push(`  want ${r.expect}, got ${got.flow} (${got.title}: ${got.reason}): ${r.text.slice(0, 70)}`);
}
console.log(`\nrecorded requests: ${hit}/${rec.requests.length} match`); if (miss.length) console.log("misses:\n" + miss.join("\n"));
assert(hit >= 18, `match rate ${hit}/20 is under the 18/20 target`); n++;
console.log(`\n${n} passed`);
