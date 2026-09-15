// Remote CI verification — the mechanical answer to "CI blocks merge on
// GitHub" criteria. When the owner opts in (the run's remoteChecks toggle),
// the DRIVER pushes the run branch and watches the hosted GitHub Actions
// runs it triggers, feeding observed verdicts (and failed-run log excerpts)
// into the verify prompt as ground truth. Code, not model opinion.
//
// Capability is gated exactly once per run (gh binary + auth + origin remote);
// any missing piece degrades to a recorded skip — never a crash, never a gate.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EVIDENCE_CAP = 2000;
const POLL_INTERVAL_MS = 20_000;
const DEFAULT_WATCH_CAP_MS = Number(process.env.NANO_CI_TIMEOUT_MS ?? 20 * 60_000);

const cap = (s, n = EVIDENCE_CAP) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + " …(truncated)" : str;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(args, timeoutMs = 30_000, cwd) {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  return stdout;
}

/**
 * One-time capability probe: gh binary present + authenticated + a repository
 * gh can see FROM THIS DIRECTORY. Returns { ok, reason } — reason set when not ok.
 */
export async function detectCiCapability(cwd) {
  try {
    await gh(["--version"], 10_000);
  } catch {
    return { ok: false, reason: "gh CLI not found" };
  }
  try {
    await gh(["auth", "status"], 15_000);
  } catch {
    return { ok: false, reason: "gh not authenticated (gh auth login)" };
  }
  try {
    const url = (await gh(["repo", "view", "--json", "name"], 15_000, cwd)).trim();
    if (!url) return { ok: false, reason: "gh cannot access this repository" };
  } catch {
    return { ok: false, reason: "gh cannot access this repository (no origin remote, or wrong account?)" };
  }
  return { ok: true, reason: null };
}

/**
 * Watch the runs triggered by pushing `sha` on `branch`.
 * Returns { status: "pass"|"fail"|"skipped", evidence, runs: [...] }.
 * `runs` entries: { id, name, conclusion, url, log (failed-log excerpt) }.
 */
export async function watchRunsForSha({ cwd, sha, emit, watchCapMs = DEFAULT_WATCH_CAP_MS }) {
  // ~10s settle after push, like the reference's CI monitor.
  await sleep(10_000);
  let listed = [];
  try {
    const out = await gh(
      ["run", "list", "--commit", sha, "--json", "databaseId,name,status,conclusion,url", "--limit", "10"],
      30_000,
      cwd,
    );
    listed = JSON.parse(out);
  } catch (e) {
    return {
      status: "skipped",
      evidence: cap(`could not list CI runs for ${sha.slice(0, 8)}: ${e?.message ?? e}`),
      runs: [],
    };
  }
  if (!Array.isArray(listed) || listed.length === 0) {
    return {
      status: "skipped",
      evidence:
        "no CI runs triggered by this push (workflows may only trigger on pull_request or the default branch) — remote CI is unobserved, not failed",
      runs: [],
    };
  }
  emit?.({ t: "notice", s: `remote CI: ${listed.length} run(s) triggered — watching (cap ${Math.round(watchCapMs / 60000)} min)` });

  const deadline = Date.now() + watchCapMs;
  const runs = [];
  for (const r of listed) {
    let conclusion = r.conclusion;
    let status = r.status;
    while ((status === "queued" || status === "in_progress") && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const v = JSON.parse(
          await gh(["run", "view", String(r.databaseId), "--json", "status,conclusion"], 15_000, cwd),
        );
        status = v.status;
        conclusion = v.conclusion;
      } catch {
        break; // keep the last known state
      }
    }
    let log = null;
    if (status === "completed" && conclusion !== "success" && conclusion !== "skipped") {
      try {
        log = cap((await gh(["run", "view", String(r.databaseId), "--log-failed"], 30_000, cwd)).trim(), 1600);
      } catch {
        log = null;
      }
    }
    if (status !== "completed") {
      conclusion = conclusion ?? "timeout";
    }
    runs.push({
      id: r.databaseId,
      name: r.name,
      status,
      conclusion,
      url: r.url,
      log,
    });
  }

  const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped");
  const timedOut = runs.filter((r) => r.status !== "completed");
  if (failed.length > 0) {
    const detail = failed
      .map((r) => `${r.name} (${r.url}) → ${r.conclusion}${r.log ? `\nfailed-log excerpt:\n${r.log}` : ""}`)
      .join("\n\n");
    return { status: "fail", evidence: cap(`${failed.length} CI run(s) failed. ${detail}`), runs };
  }
  if (timedOut.length > 0) {
    return {
      status: "fail",
      evidence: cap(`${timedOut.length} CI run(s) did not finish within the watch cap — treated as failed: ${timedOut.map((r) => `${r.name} (${r.url})`).join("; ")}`),
      runs,
    };
  }
  return {
    status: "pass",
    evidence: `all ${runs.length} CI run(s) green: ${runs.map((r) => `${r.name} (${r.url})`).join("; ")}`,
    runs,
  };
}
