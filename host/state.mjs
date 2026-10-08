// Run state — the single source of truth (runs/<id>/state.json), plus an
// append-only events journal for GUI replay after the fact.
//
// Write discipline:
//   - state.json is written ATOMICALLY (temp + fsync + rename). Status
//     transitions hit disk immediately (and flush the run's buffered events);
//     other emits are coalesced onto a short trailing timer, since the engine
//     mutates one object and emits constantly.
//   - events.jsonl is BUFFERED: adjacent assistant text/thinking deltas for the
//     same node coalesce into one record (same {ts,nodeId,ev} line format as
//     before — the first delta's ts), and the buffer is appended in one write
//     per flush. Flushes: timer, size threshold, status transition, loadRun /
//     listRuns / readRunState (read-your-writes), and a SYNC flush on process
//     exit / SIGINT / SIGTERM so nothing is lost.
//   - Reads never create directories. Only saveState / appendEvent create a
//     run dir, and only for a run this process has not already seen — a run
//     dir deleted from under us (DELETE /api/runs/:id) is not resurrected by a
//     late flush; call discardRun(id) when deleting to drop pending buffers.
import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./fsutil.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const FLUSH_MS = Number(process.env.NANO_FLUSH_MS ?? 250);
const EVENT_FLUSH_BYTES = 512 * 1024; // flush a run's event buffer past this
const EVENT_BUFFER_MAX = 32 * 1024 * 1024; // give up retrying a failing disk past this
const COALESCE = new Set(["text", "think"]);

/** Pure: the runs root. Tests point NANO_RUNS_DIR at a throwaway dir. */
export function runsDir() {
  return process.env.NANO_RUNS_DIR ? path.resolve(process.env.NANO_RUNS_DIR) : path.join(ROOT, "runs");
}

/** Pure path join (no mkdir). The id must be a single safe path segment. */
export function runDir(runId) {
  const id = String(runId);
  if (!/^[\w.-]+$/.test(id) || id === "." || id === "..") throw new Error(`invalid run id: ${id}`);
  return path.join(runsDir(), id);
}

export function newRunId() {
  const t = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}${p(t.getMilliseconds(), 3)}`;
}

// --- write-side bookkeeping ----------------------------------------------------

const known = new Set(); // runDir paths this process has created/written
const pendingState = new Map(); // dir -> state object (latest reference)
const lastStatus = new Map(); // dir -> status last written to disk
const evBuf = new Map(); // dir -> { recs: [{ts,nodeId,ev}], bytes }
let timer = null;

function ensureDir(dir) {
  if (known.has(dir)) {
    // Seen before: if it vanished, the run was deleted — don't resurrect it.
    return fs.existsSync(dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  known.add(dir);
  return true;
}

function arm() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushAll();
  }, FLUSH_MS);
  timer.unref?.();
}

function writeState(dir, state) {
  if (!ensureDir(dir)) {
    pendingState.delete(dir);
    evBuf.delete(dir);
    return;
  }
  writeJsonAtomic(path.join(dir, "state.json"), state);
  lastStatus.set(dir, state?.status);
}

function writeEvents(dir) {
  const buf = evBuf.get(dir);
  if (!buf || buf.recs.length === 0) return;
  if (!ensureDir(dir)) {
    evBuf.delete(dir);
    return;
  }
  const out = buf.recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(path.join(dir, "events.jsonl"), out);
  evBuf.delete(dir);
}

function flushDir(dir) {
  const st = pendingState.get(dir);
  if (st !== undefined) {
    pendingState.delete(dir);
    try {
      writeState(dir, st);
    } catch (e) {
      pendingState.set(dir, st); // retry next tick
      console.error(`[state] write failed for ${dir}: ${e?.message ?? e}`);
      arm();
    }
  }
  try {
    writeEvents(dir);
  } catch (e) {
    const buf = evBuf.get(dir);
    if (buf && buf.bytes > EVENT_BUFFER_MAX) evBuf.delete(dir); // disk is gone; stop growing
    console.error(`[state] event append failed for ${dir}: ${e?.message ?? e}`);
    if (evBuf.has(dir)) arm();
  }
}

/** Synchronously persist everything pending (all runs). Safe to call anytime. */
export function flushAll() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const dir of new Set([...pendingState.keys(), ...evBuf.keys()])) flushDir(dir);
}

/** Synchronously persist one run's pending state + events. */
export function flushRun(runId) {
  flushDir(runDir(runId));
}

/** Drop a run's pending buffers without writing (call when deleting the run dir). */
export function discardRun(runId) {
  const dir = runDir(runId);
  pendingState.delete(dir);
  evBuf.delete(dir);
  lastStatus.delete(dir);
  known.delete(dir);
}

process.on("exit", flushAll);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushAll();
    // Only re-raise when nobody else handles the signal — otherwise the owner's
    // own graceful-shutdown handler decides what happens next.
    if (process.listenerCount(sig) === 1) {
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    }
  });
}

// --- public write API ----------------------------------------------------------

export function saveState(runId, state) {
  const dir = runDir(runId);
  const transition = !lastStatus.has(dir) || lastStatus.get(dir) !== state?.status;
  if (transition) {
    pendingState.delete(dir);
    writeState(dir, state);
    try {
      writeEvents(dir); // keep the journal in step with the milestone
    } catch (e) {
      console.error(`[state] event append failed for ${dir}: ${e?.message ?? e}`);
    }
  } else {
    pendingState.set(dir, state); // serialised at flush time — latest wins
    arm();
  }
}

export function appendEvent(runId, nodeId, ev, ts = Date.now()) {
  const dir = runDir(runId);
  let buf = evBuf.get(dir);
  if (!buf) evBuf.set(dir, (buf = { recs: [], bytes: 0 }));
  const last = buf.recs[buf.recs.length - 1];
  if (
    last &&
    last.nodeId === nodeId &&
    COALESCE.has(ev?.t) &&
    last.ev.t === ev.t &&
    typeof last.ev.s === "string" &&
    typeof ev.s === "string"
  ) {
    last.ev = { ...last.ev, s: last.ev.s + ev.s };
    buf.bytes += ev.s.length;
  } else {
    buf.recs.push({ ts, nodeId, ev });
    buf.bytes += 64 + (typeof ev?.s === "string" ? ev.s.length : 256);
  }
  if (buf.bytes >= EVENT_FLUSH_BYTES) flushDir(dir);
  else arm();
}

// --- reads (no side effects on the filesystem) --------------------------------

/** Raw state for a run, read-your-writes. null when missing; throws {code:"EUNREADABLE"} when corrupt. */
export function readRunState(runId) {
  const dir = runDir(runId);
  flushDir(dir);
  const r = readJsonSafe(path.join(dir, "state.json"), { keepCopy: false });
  if (r.status === "ok") return r.data;
  if (r.status === "missing") return null;
  const err = new Error(`state.json for run ${runId} is unreadable: ${r.error}`);
  err.code = "EUNREADABLE";
  throw err;
}

export function listRuns() {
  flushAll();
  const dir = runsDir();
  let ids;
  try {
    ids = fs.readdirSync(dir);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const id of ids.sort().reverse()) {
    const r = readJsonSafe(path.join(dir, id, "state.json"), { keepCopy: false });
    if (r.status === "missing") continue; // not a run dir
    if (r.status === "corrupt") {
      // Never let a damaged state.json make the run vanish — surface it; the
      // file stays on disk untouched for the owner to inspect/repair.
      out.push({ id, task: null, tier: null, project: null, status: "unreadable", createdAt: null, error: r.error });
      continue;
    }
    const s = r.data ?? {};
    out.push({
      id: s.id ?? id,
      task: s.task,
      tier: s.tier,
      project: s.project,
      status: s.status,
      createdAt: s.createdAt,
    });
  }
  return out;
}

// GUI runs get the most recent window of events, not the full journal — long
// runs can reach hundreds of thousands of events, and shipping all of them
// made /api/runs/:id return 60+ MB payloads the browser choked on. Matches
// the client-side buffer cap (web/src/App.tsx slices to the last 3000).
const EVENT_CAP = 3000;

export function loadRun(runId, eventCap = EVENT_CAP) {
  const dir = runDir(runId);
  flushDir(dir);
  const state = readRunState(runId);
  if (state === null) {
    const err = new Error(`run not found: ${runId}`);
    err.code = "ENOENT";
    throw err;
  }
  const events = [];
  let totalEvents = 0;
  let buf = null;
  try {
    buf = fs.readFileSync(path.join(dir, "events.jsonl"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (buf) {
    // Scan line-start offsets first (cheap byte pass, no JSON parsing), then
    // parse only the trailing `eventCap` lines.
    const starts = [0];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1);
    if (starts[starts.length - 1] === buf.length) starts.pop(); // trailing newline
    totalEvents = starts.length;
    const first = Math.max(0, starts.length - eventCap);
    for (let j = first; j < starts.length; j++) {
      const end = j + 1 < starts.length ? starts[j + 1] - 1 : buf.length;
      const line = buf.toString("utf8", starts[j], end);
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a torn line (crash mid-append) must not make the whole run unreadable */
      }
    }
  }
  return { state, events, totalEvents };
}

// --- retention -----------------------------------------------------------------

function hasContent(p) {
  let st;
  try { st = fs.statSync(p); } catch { return false; }
  if (st.isFile()) return st.size > 0;
  if (!st.isDirectory()) return true;
  return fs.readdirSync(p).some((n) => hasContent(path.join(p, n)));
}

/**
 * Remove junk run dirs: no state.json, no (non-empty) events.jsonl, nothing
 * else of substance, and older than `minAgeMinutes`. Returns { removed, kept }
 * (ids). `dryRun: true` only reports. Never touches dirs with a state.json.
 * Manual: node -e 'import("./host/state.mjs").then(m=>console.log(m.pruneEmptyRunDirs({minAgeMinutes:60,dryRun:true})))'
 */
export function pruneEmptyRunDirs({ minAgeMinutes = 60, dryRun = false, dir = runsDir(), now = Date.now() } = {}) {
  const removed = [];
  const kept = [];
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return { removed, kept }; }
  for (const id of ids) {
    const p = path.join(dir, id);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const fresh = now - st.mtimeMs < minAgeMinutes * 60_000;
    if (fresh || fs.existsSync(path.join(p, "state.json")) || hasContent(p)) {
      kept.push(id);
      continue;
    }
    if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
    removed.push(id);
  }
  return { removed, kept };
}
