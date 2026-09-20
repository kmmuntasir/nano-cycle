// Regression (V2 owner-run failure): a tool held open LONGER than the stall
// timeout — a human gate, a coder subagent — must NOT abort the session.
// Run: node tests/watchdog.test.mjs
process.env.NANO_STALL_TIMEOUT_MS = "300"; // 300ms stall for a fast test
const { attachEventBridge, startStallWatchdog } = (await import("../host/runner.mjs")).__testInternals;

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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} watchdog checks passed`);
process.exit(failed ? 1 : 0);
