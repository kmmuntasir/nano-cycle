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
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}

export function saveState(runId, state) {
  fs.writeFileSync(path.join(runDir(runId), "state.json"), JSON.stringify(state, null, 2));
}

export function appendEvent(runId, nodeId, ev) {
  fs.appendFileSync(
    path.join(runDir(runId), "events.jsonl"),
    JSON.stringify({ ts: Date.now(), nodeId, ev }) + "\n",
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

export function loadRun(runId) {
  const dir = path.join(runsDir(), runId);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  let events = [];
  const evFile = path.join(dir, "events.jsonl");
  if (fs.existsSync(evFile)) {
    events = fs
      .readFileSync(evFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  return { state, events };
}
