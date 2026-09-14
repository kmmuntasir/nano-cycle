// Best-effort termination of processes a run spawned (e.g. long-lived dev
// servers, watchers, test runners left behind by a node's `bash` tool).
//
// Strategy: walk /proc, find all descendants of the server process whose
// current working directory sits inside the run's project folder, SIGTERM
// them (deepest first), then SIGKILL survivors. Never touches the server
// itself, pid 1, or anything outside the server's own process tree — so a
// user's editor or unrelated shell with the same cwd is safe.
//
// Linux-only; on other platforms (or when /proc is unavailable) it is a
// silent no-op reporting { unsupported: true }.
import fs from "node:fs";
import path from "node:path";

function readParentMap() {
  const map = new Map(); // pid -> ppid
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces/parens — ppid is the field right after the
      // last ')'.
      const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      map.set(pid, Number(after[1]));
    } catch {
      /* process exited mid-scan */
    }
  }
  return map;
}

function cwdOf(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killRunProcesses({ rootPid = process.pid, cwdPrefix, termWaitMs = 1500 } = {}) {
  const out = { terminated: [], killed: [], skipped: [], unsupported: false };
  const parentMap = readParentMap();
  if (!parentMap) {
    out.unsupported = true;
    return out;
  }
  const prefix = path.resolve(cwdPrefix ?? "") + path.sep;

  // BFS from the server pid → all descendants (with depth for deepest-first).
  const depth = new Map([[rootPid, 0]]);
  const queue = [rootPid];
  const childrenOf = new Map();
  for (const [pid, ppid] of parentMap) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf.get(cur) ?? []) {
      if (child === cur || depth.has(child)) continue;
      depth.set(child, depth.get(cur) + 1);
      queue.push(child);
    }
  }
  depth.delete(rootPid);

  const targets = [];
  for (const [pid] of depth) {
    if (pid <= 1) continue;
    const cwd = cwdOf(pid);
    if (!cwd) continue;
    if (!cwd.startsWith(prefix)) {
      out.skipped.push(pid);
      continue;
    }
    targets.push(pid);
  }
  // Deepest first so parents don't respawn/reap ordering issues.
  targets.sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));

  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
      out.terminated.push(pid);
    } catch {
      /* already gone */
    }
  }
  if (targets.length === 0) return out;

  const deadline = Date.now() + termWaitMs;
  while (Date.now() < deadline) {
    if (!targets.some(alive)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  for (const pid of targets) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      out.killed.push(pid);
    } catch {
      /* gone */
    }
  }
  return out;
}
