// Persistence-layer tests — atomic writes, corruption handling, event batching,
// side-effect-free reads, retention. Run: node tests/state.test.mjs
import { runs as RUNS, projectsFile } from "./_test-dirs.mjs"; // FIRST: isolate stores
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawnSync, spawn } from "node:child_process";
import {
  runsDir, runDir, saveState, appendEvent, listRuns, loadRun, readRunState,
  flushAll, flushRun, discardRun, pruneEmptyRunDirs,
} from "../host/state.mjs";
import { writeJsonAtomic, readJsonSafe } from "../host/fsutil.mjs";
import { loadProjects, addProject, removeProject, resolveProject, isInside, projectsRegistryError, SANDBOX_DIR } from "../host/projects.mjs";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split("\n").slice(0, 3).join("\n      ")}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `nano-state-${n}-`));
const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let seq = 0;
const rid = () => `t${Date.now()}-${++seq}`;

await test("runsDir/runDir/listRuns/loadRun/readRunState are side-effect free", () => {
  const prev = process.env.NANO_RUNS_DIR;
  const ghost = path.join(tmp("ghost"), "never-created");
  process.env.NANO_RUNS_DIR = ghost;
  try {
    assert.strictEqual(runsDir(), ghost);
    runDir("nope");
    assert.deepStrictEqual(listRuns(), []);
    assert.strictEqual(readRunState("nope"), null);
    assert.throws(() => loadRun("nope"), (e) => e.code === "ENOENT");
    assert.ok(!fs.existsSync(ghost), "reads must not create the runs dir");
  } finally {
    process.env.NANO_RUNS_DIR = prev;
  }
  const id = rid();
  const before = fs.readdirSync(RUNS).length;
  runDir(id); readRunState(id); try { loadRun(id); } catch { /* missing */ }
  assert.strictEqual(fs.readdirSync(RUNS).length, before, "no run dir created by reads");
});

await test("runDir rejects ids that escape the runs dir", () => {
  for (const bad of ["..", ".", "a/b", "../x", ""]) assert.throws(() => runDir(bad), /invalid run id/, bad);
});

await test("writeJsonAtomic: round-trips, leaves no temp files, failure keeps the old file", () => {
  const d = tmp("atomic");
  const f = path.join(d, "x.json");
  writeJsonAtomic(f, { a: 1 });
  writeJsonAtomic(f, { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(d), ["x.json"]);
  // target is a directory -> rename fails; temp must be cleaned, original untouched
  const dirTarget = path.join(d, "dir.json");
  fs.mkdirSync(dirTarget);
  fs.writeFileSync(path.join(dirTarget, "keep"), "1");
  assert.throws(() => writeJsonAtomic(dirTarget, { a: 3 }));
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ["dir.json", "x.json"], "no leaked temp file");
  // circular value throws BEFORE touching the file
  const circ = {}; circ.self = circ;
  assert.throws(() => writeJsonAtomic(f, circ));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
});

await test("readJsonSafe: ok / missing / corrupt (copy kept once, never empty)", () => {
  const d = tmp("safe");
  const f = path.join(d, "s.json");
  assert.strictEqual(readJsonSafe(f).status, "missing");
  fs.writeFileSync(f, '{"ok":true}');
  assert.deepStrictEqual(readJsonSafe(f), { status: "ok", data: { ok: true } });
  fs.writeFileSync(f, '{"ok":tr'); // truncated
  const r1 = readJsonSafe(f);
  assert.strictEqual(r1.status, "corrupt");
  assert.ok(r1.copy && fs.existsSync(r1.copy), "corrupt copy kept");
  assert.strictEqual(fs.readFileSync(r1.copy, "utf8"), '{"ok":tr');
  const r2 = readJsonSafe(f);
  assert.strictEqual(r2.copy, r1.copy, "same damage -> same copy, no pile-up");
  assert.strictEqual(fs.readdirSync(d).filter((n) => n.includes(".corrupt-")).length, 1);
  fs.writeFileSync(f, ""); // empty is corrupt too, not "no data"
  assert.strictEqual(readJsonSafe(f, { keepCopy: false }).status, "corrupt");
  assert.throws(() => readJsonSafe(d), /EISDIR/, "non-ENOENT I/O errors are thrown");
});

await test("truncated state.json: run stays in listRuns as 'unreadable', file untouched", () => {
  const good = rid(), bad = rid();
  saveState(good, { id: good, task: "ok", status: "completed", createdAt: 1 });
  saveState(bad, { id: bad, task: "t", status: "completed", createdAt: 2 });
  flushAll();
  const f = path.join(runDir(bad), "state.json");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, 20));
  const before = fs.readFileSync(f, "utf8");
  const list = listRuns();
  const entry = list.find((r) => r.id === bad);
  assert.ok(entry, "corrupt run must not vanish");
  assert.strictEqual(entry.status, "unreadable");
  assert.ok(entry.error);
  assert.strictEqual(list.find((r) => r.id === good).status, "completed");
  assert.strictEqual(fs.readFileSync(f, "utf8"), before, "file kept as-is");
  assert.throws(() => loadRun(bad), (e) => e.code === "EUNREADABLE");
  // the engine's next write heals it
  saveState(bad, { id: bad, task: "t", status: "running", createdAt: 2 });
  assert.strictEqual(loadRun(bad).state.status, "running");
});

await test("state: status transitions hit disk immediately; other emits coalesce, reads still see them", async () => {
  const id = rid();
  const f = path.join(runDir(id), "state.json");
  const st = { id, status: "running", n: 0 };
  saveState(id, st);
  assert.ok(fs.existsSync(f), "first write is immediate");
  st.n = 1; saveState(id, st);
  st.n = 2; saveState(id, st);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).n, 0, "non-transition emits are coalesced");
  assert.strictEqual(loadRun(id).state.n, 2, "loadRun is read-your-writes");
  st.n = 3; saveState(id, st);
  await sleep(500);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).n, 3, "timer flushed the latest state");
  st.status = "awaiting-gate"; st.n = 4; saveState(id, st);
  const onDisk = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.strictEqual(onDisk.status, "awaiting-gate", "transition written immediately");
  assert.strictEqual(onDisk.n, 4);
  assert.deepStrictEqual(fs.readdirSync(runDir(id)).filter((n) => n.endsWith(".tmp")), []);
});

await test("events: adjacent text/think deltas coalesce; other kinds & nodes break the run; order kept", () => {
  const id = rid();
  const f = path.join(runDir(id), "events.jsonl");
  for (let i = 0; i < 500; i++) appendEvent(id, "build", { t: "text", s: "a" }, 1000 + i);
  appendEvent(id, "build", { t: "think", s: "x" }, 2000);
  appendEvent(id, "build", { t: "think", s: "y" }, 2001);
  appendEvent(id, "build", { t: "tool", name: "bash", args: "ls" }, 2002);
  appendEvent(id, "build", { t: "text", s: "b" }, 2003);
  appendEvent(id, "verify", { t: "text", s: "c" }, 2004); // other node: no merge
  appendEvent(id, "verify", { t: "text", s: "d" }, 2005);
  assert.ok(!fs.existsSync(f), "buffered, not yet on disk");
  flushRun(id);
  const recs = lines(f);
  assert.deepStrictEqual(recs.map((r) => [r.nodeId, r.ev.t]), [
    ["build", "text"], ["build", "think"], ["build", "tool"], ["build", "text"], ["verify", "text"],
  ]);
  assert.strictEqual(recs[0].ev.s, "a".repeat(500));
  assert.strictEqual(recs[0].ts, 1000, "first delta's ts");
  assert.strictEqual(recs[1].ev.s, "xy");
  assert.strictEqual(recs[4].ev.s, "cd");
  // a later flush window starts a new record (no rewrite of flushed lines)
  appendEvent(id, "verify", { t: "text", s: "e" }, 3000);
  flushRun(id);
  assert.strictEqual(lines(f).length, 6);
  saveState(id, { id, status: "running" });
  const { events, totalEvents } = loadRun(id);
  assert.strictEqual(totalEvents, 6);
  assert.strictEqual(events[0].ev.s.length, 500);
});

await test("events: timer flushes without an explicit call; transition flushes the journal", async () => {
  const id = rid();
  const f = path.join(runDir(id), "events.jsonl");
  appendEvent(id, "n", { t: "notice", s: "hi" });
  assert.ok(!fs.existsSync(f));
  await sleep(500);
  assert.strictEqual(lines(f).length, 1);
  const id2 = rid();
  appendEvent(id2, "n", { t: "notice", s: "before" });
  saveState(id2, { id: id2, status: "running" }); // first save = transition
  assert.strictEqual(lines(path.join(runDir(id2), "events.jsonl")).length, 1);
});

await test("events: large buffer flushes by size; torn last line doesn't break loadRun", () => {
  const id = rid();
  const f = path.join(runDir(id), "events.jsonl");
  appendEvent(id, "n", { t: "notice", s: "x".repeat(600 * 1024) });
  assert.ok(fs.existsSync(f), "size threshold flush");
  fs.appendFileSync(f, '{"ts":1,"nodeId":"n","ev":{"t":"te'); // crash mid-append
  saveState(id, { id, status: "running" });
  const r = loadRun(id);
  assert.strictEqual(r.events.length, 1, "torn line skipped");
});

await test("exit flush: normal exit and SIGTERM lose nothing", async () => {
  const dir = tmp("exit");
  const stateUrl = new URL("../host/state.mjs", import.meta.url).href;
  const body = `import {appendEvent,saveState} from ${JSON.stringify(stateUrl)};
    saveState("r1",{id:"r1",status:"running",k:0}); saveState("r1",{id:"r1",status:"running",k:9});
    for (let i=0;i<50;i++) appendEvent("r1","n",{t:"text",s:"z"});`;
  const env = { ...process.env, NANO_RUNS_DIR: dir };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", body + " process.exit(0)"], { env });
  assert.strictEqual(r.status, 0, String(r.stderr));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "r1/state.json"), "utf8")).k, 9);
  assert.strictEqual(lines(path.join(dir, "r1/events.jsonl"))[0].ev.s.length, 50);

  const dir2 = tmp("sigterm");
  const child = spawn(process.execPath, ["--input-type=module", "-e", body + " console.log('ready'); setInterval(()=>{},1000)"], { env: { ...env, NANO_RUNS_DIR: dir2 } });
  await new Promise((res) => child.stdout.once("data", res));
  const exited = new Promise((res) => child.once("exit", (code, sig) => res(sig)));
  child.kill("SIGTERM");
  assert.strictEqual(await exited, "SIGTERM", "default signal semantics preserved");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir2, "r1/state.json"), "utf8")).k, 9);
  assert.strictEqual(lines(path.join(dir2, "r1/events.jsonl"))[0].ev.s.length, 50);
});

await test("a deleted run dir is not resurrected by a late flush; discardRun drops buffers", () => {
  const id = rid();
  saveState(id, { id, status: "running" });
  appendEvent(id, "n", { t: "notice", s: "x" });
  fs.rmSync(runDir(id), { recursive: true, force: true }); // as DELETE /api/runs/:id does
  flushAll();
  assert.ok(!fs.existsSync(runDir(id)), "no resurrection");
  const id2 = rid();
  saveState(id2, { id: id2, status: "running" });
  saveState(id2, { id: id2, status: "running", late: true });
  appendEvent(id2, "n", { t: "notice", s: "x" });
  discardRun(id2);
  fs.rmSync(runDir(id2), { recursive: true, force: true });
  flushAll();
  assert.ok(!fs.existsSync(runDir(id2)));
});

await test("pruneEmptyRunDirs: removes only old, empty, state-less dirs (temp dir only)", () => {
  const d = tmp("prune");
  const mk = (name, files = {}, ageMin = 120) => {
    const p = path.join(d, name);
    fs.mkdirSync(p, { recursive: true });
    for (const [n, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(p, n)), { recursive: true });
      fs.writeFileSync(path.join(p, n), c);
    }
    const t = new Date(Date.now() - ageMin * 60_000);
    fs.utimesSync(p, t, t);
  };
  mk("junk-old");
  mk("junk-empty-events", { "events.jsonl": "" });
  mk("junk-empty-sessions", {});
  fs.mkdirSync(path.join(d, "junk-empty-sessions", "sessions"));
  { const t = new Date(Date.now() - 120 * 60_000); fs.utimesSync(path.join(d, "junk-empty-sessions"), t, t); }
  mk("junk-new", {}, 1);
  mk("has-state", { "state.json": "{}" });
  mk("has-events", { "events.jsonl": "{}\n" });
  mk("has-session", { "sessions/a.jsonl": "x" });
  fs.writeFileSync(path.join(d, "stray-file"), "x");
  const dry = pruneEmptyRunDirs({ dir: d, minAgeMinutes: 30, dryRun: true });
  assert.deepStrictEqual(dry.removed.sort(), ["junk-empty-events", "junk-empty-sessions", "junk-old"]);
  assert.ok(fs.existsSync(path.join(d, "junk-old")), "dry run removes nothing");
  const real = pruneEmptyRunDirs({ dir: d, minAgeMinutes: 30 });
  assert.deepStrictEqual(real.removed.sort(), dry.removed.sort());
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ["has-events", "has-session", "has-state", "junk-new", "stray-file"]);
  assert.deepStrictEqual(pruneEmptyRunDirs({ dir: path.join(d, "missing") }), { removed: [], kept: [] });
});

// --- projects registry ---------------------------------------------------------

await test("projects: first boot seeds sandbox atomically; add/remove/resolve are registry-only", () => {
  assert.ok(!fs.existsSync(projectsFile), "test registry starts absent");
  assert.deepStrictEqual(loadProjects(), [{ name: "sandbox", path: SANDBOX_DIR }]);
  assert.ok(fs.existsSync(projectsFile));
  const a = tmp("projA");
  addProject({ name: "a", path: a });
  assert.deepStrictEqual(resolveProject("a"), { name: "a", path: a });
  assert.deepStrictEqual(resolveProject(a), { name: "a", path: a }, "exact registered path resolves to its entry");
  assert.throws(() => resolveProject(os.tmpdir()), /unknown project/, "unregistered absolute path rejected");
  assert.throws(() => resolveProject("/etc"), /unknown project/);
  assert.throws(() => resolveProject("nope"), /unknown project/);
  assert.throws(() => resolveProject(undefined), /unknown project/);
  removeProject("a");
  assert.throws(() => resolveProject("a"), /unknown project/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(projectsFile)), ["projects.json"], "no temp leftovers");
});

await test("projects: corrupt registry is never overwritten; reads degrade, writes refuse", () => {
  const good = tmp("projB");
  addProject({ name: "b", path: good });
  const broken = fs.readFileSync(projectsFile, "utf8").slice(0, 25);
  fs.writeFileSync(projectsFile, broken);
  assert.deepStrictEqual(loadProjects(), [], "read degrades to empty, server stays up");
  assert.ok(projectsRegistryError());
  assert.throws(() => addProject({ name: "c", path: good }), /corrupt.*refusing to overwrite/);
  assert.throws(() => removeProject("b"), /corrupt/);
  assert.strictEqual(fs.readFileSync(projectsFile, "utf8"), broken, "file untouched");
  assert.ok(fs.readdirSync(path.dirname(projectsFile)).some((n) => n.includes(".corrupt-")), "copy kept");
  // owner fixes the file -> writes work again
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [] }));
  assert.deepStrictEqual(loadProjects(), []);
  assert.strictEqual(projectsRegistryError(), null, "healthy again");
  addProject({ name: "c", path: good });
  assert.deepStrictEqual(loadProjects().map((p) => p.name), ["c"]);
});

await test("isInside: separator-aware containment (path.relative)", () => {
  assert.ok(isInside("/a/app", "/a/app"));
  assert.ok(isInside("/a/app", "/a/app/src/x.js"));
  assert.ok(!isInside("/a/app", "/a/app-secrets"), "prefix without separator is NOT inside");
  assert.ok(!isInside("/a/app", "/a/app/../app-secrets/x"));
  assert.ok(!isInside("/a/app", "/a"));
  assert.ok(!isInside("/a/app", "/b"));
  assert.ok(isInside("/", "/etc"));
  assert.ok(isInside("/a/app", "/a/app/./b/../c"));
});

flushAll();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} state tests passed`);
process.exit(failed ? 1 : 0);
