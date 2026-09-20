// TODO 2 — SDK persistence spike (docs/PLAN-v2-step-workflow.md, Phase 0).
// Proves the five assumptions the v2 engine rests on, against the real SDK:
//   (a) SessionManager.create(cwd, sessionDir) persists; file path retrievable
//   (b) SessionManager.open(path) resumes with full conversational context
//   (c) a custom tool whose execute() blocks on an external promise works
//       mid-turn and the model continues with its result
//   (d) session.abort() during a blocked tool settles cleanly
//   (e) systemPromptOverride applies to resumed sessions
// Run: node spike/session-persistence.mjs [provider/model]
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MODEL_SPEC = process.argv[2] ?? "opencode/claude-haiku-4-5";
const SPIKE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "nano-spike-"));
const SESSIONS_DIR = path.join(SPIKE_DIR, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
const hit = (available ?? []).find((m) => `${m.provider}/${m.id}` === MODEL_SPEC);
if (!hit) {
  console.error(`model ${MODEL_SPEC} not in runtime catalog (have ${(available ?? []).length})`);
  process.exit(2);
}
console.log(`spike dir: ${SPIKE_DIR}\nmodel:     ${MODEL_SPEC}\n`);

const SYSTEM = "You are SPIKE-ASSISTANT. When asked 'what is your role', you answer with exactly: spike-test-role. Be extremely terse.";

function makeLoader(systemPrompt) {
  return new DefaultResourceLoader({
    cwd: SPIKE_DIR,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: (current) => ({ skills: [], diagnostics: current?.diagnostics ?? [] }),
  });
}

async function prompt(session, text) {
  await session.prompt(text);
  const last = session.messages.filter((m) => m.role === "assistant").pop();
  return String(last?.content?.map((c) => c.text ?? "").join("") ?? "").trim();
}

// --- (a) create persists + path retrieval --------------------------------------
let sessionFile = null;
{
  const loader = makeLoader(SYSTEM);
  await loader.reload();
  const mgr = SessionManager.create(SPIKE_DIR, SESSIONS_DIR);
  const { session } = await createAgentSession({
    cwd: SPIKE_DIR,
    modelRuntime,
    model: hit,
    tools: [],
    resourceLoader: loader,
    sessionManager: mgr,
  });
  sessionFile = mgr.getSessionFile?.() ?? session.sessionFile ?? null;
  check("(a) persisted session file retrievable", !!sessionFile, String(sessionFile));

  const answer = await prompt(session, "Remember this codeword for later: TRIDENT-42. Reply with just: stored");
  check("(a) first turn answered", answer.length > 0, answer.slice(0, 80));
}
check("(a) session file exists on disk after turn", !!sessionFile && fs.existsSync(sessionFile));

// --- (b)+(e) reopen: context retained + system prompt re-applied ----------------
{
  const loader = makeLoader(SYSTEM); // fresh loader — as the engine would build on resume
  await loader.reload();
  const mgr = SessionManager.open(sessionFile);
  const { session } = await createAgentSession({
    cwd: SPIKE_DIR,
    modelRuntime,
    model: hit,
    tools: [],
    resourceLoader: loader,
    sessionManager: mgr,
  });
  const recall = await prompt(session, "What was the codeword? Answer with the word only.");
  check("(b) resumed session retains context", /trident[-\s]?42/i.test(recall), recall.slice(0, 80));
  const role = await prompt(session, "what is your role");
  check("(e) systemPromptOverride applies on resume", /spike-test-role/i.test(role), role.slice(0, 80));
}

// --- (c) blocking tool: model continues with the gate's result -----------------
{
  const loader = makeLoader(SYSTEM);
  await loader.reload();
  const mgr = SessionManager.create(SPIKE_DIR, SESSIONS_DIR);
  let releaseGate;
  let toolEntered = false; // set the moment execute() runs — direct proof the turn is blocked inside the tool
  const gate = new Promise((resolve) => (releaseGate = resolve));
  const gateTool = {
    name: "request_decision",
    label: "Request decision",
    description: "Ask the owner for a decision. Blocks until answered.",
    parameters: Type.Object({ question: Type.String() }),
    execute: async (_id, params) => {
      toolEntered = true;
      const decision = await gate; // blocks mid-turn until we release
      return { content: [{ type: "text", text: `OWNER DECISION: ${decision}` }], details: {} };
    },
  };
  // minimal defineTool-compatible custom tool (uses the SDK's own factory in runner.mjs;
  // here we inline a plain object with the same shape the SDK accepts via customTools)
  const { defineTool } = await import("@earendil-works/pi-coding-agent");
  const tool = defineTool(gateTool);
  const { session } = await createAgentSession({
    cwd: SPIKE_DIR,
    modelRuntime,
    model: hit,
    tools: ["request_decision"],
    customTools: [tool],
    resourceLoader: loader,
    sessionManager: mgr,
  });
  const answerP = prompt(session, "Call request_decision with question 'proceed?'. Then tell me the owner's decision verbatim and nothing else.");
  let settledEarly = false;
  answerP.then(() => (settledEarly = true)).catch(() => (settledEarly = true));
  for (let i = 0; i < 40 && !toolEntered; i++) await new Promise((r) => setTimeout(r, 500)); // up to 20s for the call
  check("(c) tool call issued and turn still open", toolEntered === true && settledEarly === false, `toolEntered=${toolEntered} settledEarly=${settledEarly}`);
  releaseGate("APPROVED-77");
  const answer = await answerP;
  check("(c) model continued with blocked tool result", /APPROVED-77/.test(answer), answer.slice(0, 90));

  // --- (d) abort during a blocked tool ----------------------------------------
  const mgr2 = SessionManager.create(SPIKE_DIR, SESSIONS_DIR);
  let release2;
  const gate2 = new Promise((resolve) => (release2 = resolve));
  const tool2 = defineTool({
    ...gateTool,
    name: "request_decision_2",
    execute: async (_id, params) => {
      const d = await gate2;
      return { content: [{ type: "text", text: `OWNER DECISION: ${d}` }], details: {} };
    },
  });
  const s2 = await createAgentSession({
    cwd: SPIKE_DIR,
    modelRuntime,
    model: hit,
    tools: ["request_decision_2"],
    customTools: [tool2],
    resourceLoader: loader,
    sessionManager: mgr2,
  });
  const answer2P = prompt(s2.session, "Call request_decision_2 with question 'x'. Then say done.");
  await new Promise((r) => setTimeout(r, 4000));
  let settled = false;
  answer2P.then(() => (settled = true)).catch(() => (settled = true));
  await s2.session.abort(); // cancel-during-gate
  await new Promise((r) => setTimeout(r, 1500));
  release2("never-seen");
  await new Promise((r) => setTimeout(r, 500));
  check("(d) abort during blocked tool settles (no hang)", settled === true, `settled=${settled}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(SPIKE_DIR, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
