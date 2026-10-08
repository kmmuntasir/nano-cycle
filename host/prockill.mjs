// Best-effort termination of processes a run spawned (e.g. long-lived dev
// servers, watchers, test runners left behind by a node's `bash` tool).
//
// Two selection modes:
//
//  1. runId (preferred): the engine's guarded bash tool stamps every command
//     it spawns with NANO_RUN_ID=<run id> (runner.mjs spawnHook), and the tag
//     is inherited by everything those commands start. We find processes by
//     that tag in /proc/<pid>/environ — exact to ONE run, so cancelling a run
//     never touches another run's processes (or a clarify run's analyst) on the
//     same project, and daemonised children that were reparented to init are
//     still found.
//  2. cwdPrefix (fallback, untagged): descendants of the server process whose
//     cwd is the project root OR anywhere beneath it.
//
// Never touches the server itself or pid 1. SIGTERM deepest-first, then SIGKILL
// survivors after a non-blocking grace wait (the old Atomics.wait froze the
// whole server's event loop).
//
// Linux-only; on other platforms (or when /proc is unavailable) it is a silent
// no-op reporting { unsupported: true }.
import fs from "node:fs";
import path from "node:path";

export const RUN_TAG_ENV = "NANO_RUN_ID";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** True when the process environment carries NANO_RUN_ID=<runId> (exact match). */
function hasRunTag(pid, runId) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return env.split("\0").includes(`${RUN_TAG_ENV}=${runId}`);
  } catch {
    return false; // not ours / exited / unreadable
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

/** cwd is the root itself or any path beneath it (no sibling-prefix false hits). */
export function cwdInside(cwd, root) {
  const rel = path.relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function killRunProcesses({ rootPid = process.pid, cwdPrefix, runId, termWaitMs = 1500 } = {}) {
  const out = { terminated: [], killed: [], skipped: [], unsupported: false };
  const parentMap = readParentMap();
  if (!parentMap) {
    out.unsupported = true;
    return out;
  }

  // Depth from the server pid (for deepest-first ordering; also the candidate
  // set in cwd mode).
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
  const depthOf = (pid) => {
    if (depth.has(pid)) return depth.get(pid);
    // Reparented process: order by its own ancestry length (deeper = later in the tree).
    let d = 0;
    for (let p = parentMap.get(pid); p && p > 1 && d < 64; p = parentMap.get(p)) d += 1;
    return d;
  };

  const root = cwdPrefix ? path.resolve(cwdPrefix) : null;
  const candidates = runId ? [...parentMap.keys()] : [...depth.keys()].filter((p) => p !== rootPid);
  const targets = [];
  for (const pid of candidates) {
    if (pid <= 1 || pid === process.pid || pid === rootPid) continue;
    if (runId) {
      if (hasRunTag(pid, runId)) targets.push(pid);
      continue;
    }
    if (!root) continue;
    const cwd = cwdOf(pid);
    if (!cwd) continue;
    if (!cwdInside(cwd, root)) {
      out.skipped.push(pid);
      continue;
    }
    targets.push(pid);
  }
  // Deepest first so parents don't respawn/reap ordering issues.
  targets.sort((a, b) => depthOf(b) - depthOf(a));

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
    await sleep(100);
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
