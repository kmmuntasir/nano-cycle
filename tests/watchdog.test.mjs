// Regression (V2 owner-run failure): a tool held open LONGER than the stall
// timeout — a human gate, a coder subagent — must NOT abort the session.
// Run: node tests/watchdog.test.mjs
process.env.NANO_STALL_TIMEOUT_MS = "300"; // 300ms stall for a fast test
process.env.NANO_BASH_TIMEOUT_S = "1"; // default pi-bash timeout for the E-10 check
const { attachEventBridge, startStallWatchdog, makeStepPrompt, guardedBashTool } = (await import("../host/runner.mjs")).__testInternals;
const { killRunProcesses, cwdInside, RUN_TAG_ENV } = await import("../host/prockill.mjs");
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

function fakeSession() {
  const cbs = [];
  return {
    subscribe: (cb) => { cbs.push(cb); return () => {}; },
    emit: (evt) => cbs.forEach((cb) => cb(evt)),
  };
}
const onEvent = () => {};

// 1. tool in flight longer than STALL_MS → no abort
{
  const session = fakeSession();
  const bridge = attachEventBridge(session, "build", onEvent);
  let aborted = false;
  const wd = startStallWatchdog(bridge, () => (aborted = true));
  session.emit({ type: "tool_execution_start", toolName: "submit_plan", args: {} });
  await sleep(700); // > 300ms stall, tool still open (gate waiting for human)
  check("tool in flight > STALL_MS → no abort (gate wait is not a stall)", !aborted);
  session.emit({ type: "tool_execution_end", toolName: "submit_plan", isError: false });
  wd.clear();
}

// 2. tool returns, then genuine silence > STALL_MS → abort fires
{
  const session = fakeSession();
  const bridge = attachEventBridge(session, "build", onEvent);
  let aborted = false;
  const wd = startStallWatchdog(bridge, () => (aborted = true));
  session.emit({ type: "tool_execution_start", toolName: "submit_plan", args: {} });
  await sleep(100);
  session.emit({ type: "tool_execution_end", toolName: "submit_plan", isError: false });
  await sleep(700); // silence with no tool in flight → stall
  check("silence after tool returns → abort fires (provider stall still caught)", aborted);
  wd.clear();
}

// 3. nested tools (dispatch_coder inside build): depth counting is balanced
{
  const session = fakeSession();
  const bridge = attachEventBridge(session, "build", onEvent);
  let aborted = false;
  const wd = startStallWatchdog(bridge, () => (aborted = true));
  session.emit({ type: "tool_execution_start", toolName: "dispatch_coder", args: {} });
  session.emit({ type: "tool_execution_start", toolName: "bash", args: {} });
  await sleep(400);
  session.emit({ type: "tool_execution_end", toolName: "bash", isError: false });
  session.emit({ type: "tool_execution_start", toolName: "report_artifact", args: {} });
  await sleep(400);
  check("nested tool depth > STALL_MS → no abort until the outer tool returns", !aborted);
  session.emit({ type: "tool_execution_end", toolName: "dispatch_coder", isError: false });
  wd.clear();
}

// 4. #11: stall handling matches real pi — prompt() RESOLVES on abort, stop reasons are
//    stop|toolUse|aborted (never "end"), and a stall is per PROMPT, not sticky.
{
  // a fake pi session whose prompt() resolves only when abort() is called (or after workMs)
  const mk = (workMs, withTool = false) => {
    const cbs = [];
    let release = null;
    const session = {
      messages: [],
      subscribe: (cb) => { cbs.push(cb); return () => {}; },
      emit: (evt) => cbs.forEach((cb) => cb(evt)),
      abort: async () => release?.("aborted"),
      prompt: async () => {
        const how = await new Promise((resolve) => {
          release = resolve;
          if (workMs != null) setTimeout(() => resolve("stop"), workMs);
        });
        session.messages.push({ role: "assistant", stopReason: how });
        release = null;
      },
    };
    return session;
  };
  // 4a. silence → watchdog abort → prompt resolves "aborted" → makeStepPrompt must throw stalled
  {
    const session = mk(null);
    const bridge = attachEventBridge(session, "verify", onEvent);
    const prompt = makeStepPrompt(session, bridge, () => session.abort());
    let err = null;
    await prompt("go").catch((e) => (err = e));
    check("silent turn (pi resolves aborted) → 'stalled' error thrown", /stalled/.test(String(err?.message)));
    // 4b. the NEXT prompt completes normally and must not be poisoned by the earlier stall
    session.emit({ type: "turn_end", message: { usage: { input: 1, output: 1 } } });
    const quick = mk(40);
    const b2 = attachEventBridge(quick, "verify", onEvent);
    const p2 = makeStepPrompt(quick, b2, () => quick.abort());
    let err2 = null;
    await p2("again").catch((e) => (err2 = e));
    check("a clean turn after a stall does not throw (lastStall is per prompt)", err2 === null);
  }
  // 4c. a deliberate abort (milestone stop) that is NOT a stall resolves quietly
  {
    const session = mk(null);
    const bridge = attachEventBridge(session, "build", onEvent);
    const prompt = makeStepPrompt(session, bridge, () => session.abort());
    const p = prompt("go");
    await sleep(50);
    await session.abort(); // what a milestone tool's stop() does — not the watchdog
    let err = null;
    await p.catch((e) => (err = e));
    check("milestone-style abort (not a stall) resolves without error", err === null);
  }
}

// 5. E-10: pi's bash has no default timeout — the guarded tool gives it one, and tags the run.
{
  const tool = guardedBashTool(os.tmpdir(), "run-wd-1");
  const t0 = Date.now();
  let msg = "";
  await tool.execute("c", { command: "sleep 30" }, undefined, undefined, undefined).catch((e) => (msg = e.message));
  check("foreground hang is killed by the default bash timeout", /timed out after 1 seconds/.test(msg) && Date.now() - t0 < 5000);
  const ok = await tool.execute("c", { command: "echo $" + RUN_TAG_ENV }, undefined, undefined, undefined);
  check("spawned commands carry NANO_RUN_ID", /run-wd-1/.test(ok.content[0].text));
  const long = await tool.execute("c", { command: "sleep 1.5; echo done", timeout: 10 }, undefined, undefined, undefined);
  check("an explicit model-supplied timeout is honored", /done/.test(long.content[0].text));
}

// 6. E-9: prockill — exact scoping, root-cwd processes included, no event-loop block.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nano-pk-"));
  const sibling = root + "-sibling"; // shares the string prefix, is NOT inside root
  fs.mkdirSync(sibling);
  const sleeper = (cwd, env = {}) => spawn("sleep", ["60"], { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const mine = sleeper(root, { [RUN_TAG_ENV]: "run-A" });
  const other = sleeper(root, { [RUN_TAG_ENV]: "run-B" }); // same project, different run
  const rootCwd = sleeper(root); // untagged, cwd == project root
  const sib = sleeper(sibling);
  await sleep(100);
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 10);
  const res = await killRunProcesses({ runId: "run-A", cwdPrefix: root, termWaitMs: 500 });
  clearInterval(timer);
  await sleep(100);
  check("runId mode kills exactly that run's tagged process", !alive(mine.pid) && res.terminated.includes(mine.pid));
  check("runId mode leaves another run's process on the same project alone", alive(other.pid) && alive(rootCwd.pid));
  const res2 = await killRunProcesses({ cwdPrefix: root, termWaitMs: 500 });
  await sleep(100);
  check("cwd mode: a process whose cwd IS the project root is killed (was skipped)", !alive(rootCwd.pid) && res2.terminated.includes(rootCwd.pid));
  check("cwd mode: a sibling dir sharing the path prefix is untouched", alive(sib.pid));
  check("killRunProcesses is async — the event loop kept turning", ticks >= 1);
  check("cwdInside: root, child ok; sibling prefix and parent rejected", cwdInside(root, root) && cwdInside(root + "/a/b", root) && !cwdInside(sibling, root) && !cwdInside(path.dirname(root), root));
  for (const p of [other, sib, mine, rootCwd]) { try { p.kill("SIGKILL"); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} watchdog checks passed`);
process.exit(failed ? 1 : 0);
