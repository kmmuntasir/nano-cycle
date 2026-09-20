// Run state — the single source of truth (runs/<id>/state.json), plus an
// append-only events journal for GUI replay after the fact.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

export function runsDir() {
  const dir = path.join(ROOT, "runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function runDir(runId) {
  const dir = path.join(runsDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newRunId() {
  const t = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}${p(t.getMilliseconds(), 3)}`;
}

export function saveState(runId, state) {
  fs.writeFileSync(path.join(runDir(runId), "state.json"), JSON.stringify(state, null, 2));
}

export function appendEvent(runId, nodeId, ev, ts = Date.now()) {
  fs.appendFileSync(
    path.join(runDir(runId), "events.jsonl"),
    JSON.stringify({ ts, nodeId, ev }) + "\n",
  );
}

export function listRuns() {
  const dir = runsDir();
  const out = [];
  for (const id of fs.readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, id, "state.json");
    if (!fs.existsSync(file)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      out.push({
        id: s.id,
        task: s.task,
        tier: s.tier,
        project: s.project,
        status: s.status,
        createdAt: s.createdAt,
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

// GUI runs get the most recent window of events, not the full journal — long
// runs can reach hundreds of thousands of events, and shipping all of them
// made /api/runs/:id return 60+ MB payloads the browser choked on. Matches
// the client-side buffer cap (web/src/App.tsx slices to the last 3000).
const EVENT_CAP = 3000;

export function loadRun(runId, eventCap = EVENT_CAP) {
  const dir = path.join(runsDir(), runId);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  let events = [];
  let totalEvents = 0;
  const evFile = path.join(dir, "events.jsonl");
  if (fs.existsSync(evFile)) {
    const buf = fs.readFileSync(evFile);
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
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return { state, events, totalEvents };
}
