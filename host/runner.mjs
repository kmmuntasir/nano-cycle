// Node/step runner — pi SDK sessions for pipeline nodes (v1) and v2 step
// sessions. The driver owns 100% of the context: system prompt override, zero
// context-file discovery, explicit tool allowlists, schema'd milestone tools.
//
// v2 additions (additive): per-step bundled-skill filtering and openStepSession
// — persistent sessions stored under runs/<id>/sessions that survive close and
// server restart (docs/SPIKE-NOTES.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  loadSkillsFromDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Nano-cycle's bundled skills — vendored under <root>/skills and injected per
// step (v2) or wholesale (v1 nodes). Repo-local skills stay ignored by design:
// the driver owns the context; bundled skills are the one deliberate exception.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILLS_DIR = path.join(ROOT_DIR, "skills");
let bundledSkillsCache = null;
function bundledSkills() {
  if (bundledSkillsCache === null) {
    try {
      bundledSkillsCache = loadSkillsFromDir({ dir: BUNDLED_SKILLS_DIR, source: "nano-cycle" });
    } catch {
      bundledSkillsCache = { skills: [], diagnostics: [] };
    }
  }
  return bundledSkillsCache;
}

// v2: which bundled skills each step's session carries. Step system prompts
// FORCE the mandatory phase skill loads by absolute path — the description-
// triggered progressive disclosure is not relied upon for phase law.
export const SKILLS_BY_STEP = {
  clarify: ["markdown-writer"],
  build: ["planning", "task-breakdown", "implementation", "markdown-writer"],
  verify: ["verification", "audit-deliverables", "markdown-writer"],
  security: ["security-scan", "vapt", "markdown-writer"],
};

/** Skills visible to one step (v2) — all bundled skills when stepId is unknown (v1). */
export function bundledSkillsForStep(stepId) {
  const all = bundledSkills();
  const allow = SKILLS_BY_STEP[stepId];
  if (!allow) return all;
  return { skills: all.skills.filter((s) => allow.includes(s.name)), diagnostics: all.diagnostics };
}

/** Absolute SKILL.md dir for a skill name (for system-prompt path injection). */
export function skillDirFor(name) {
  return path.join(BUNDLED_SKILLS_DIR, name);
}

function resolveModel(spec, modelRuntime) {
  if (!spec || spec === "auto") return { model: undefined, thinking: undefined };
  const parsed = resolveCliModel({ cliModel: spec, modelRuntime });
  if (parsed?.error) throw new Error(`model "${spec}": ${parsed.error}`);
  return { model: parsed?.model, thinking: parsed?.thinking ?? undefined };
}

function makeReportTool(schema, store) {
  return defineTool({
    name: "report_artifact",
    label: "Report artifact",
    description:
      "Report the structured result of this pipeline node. Call it EXACTLY ONCE when your work is done.",
    parameters: schema,
    execute: async (_toolCallId, params) => {
      store.artifacts.push(params ?? {});
      return { content: [{ type: "text", text: "Recorded. Nothing else to do." }], details: {} };
    },
  });
}

/** Generic structured-output tool factory (clarify + v2 milestone tools use it). */
export function makeTool({ name, label, description, schema, onCall }) {
  return defineTool({
    name,
    label,
    description,
    parameters: schema,
    execute: async (_toolCallId, params) => {
      onCall(params ?? {});
      return { content: [{ type: "text", text: "Recorded. Nothing else to do." }], details: {} };
    },
  });
}

function normUsage(u) {
  if (!u) return null;
  const g = (...keys) => {
    for (const k of keys) {
      const v = u[k] ?? u.tokens?.[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  return {
    input: g("input", "inputTokens", "promptTokens", "prompt"),
    output: g("output", "outputTokens", "completionTokens", "completion"),
    cacheRead: g("cacheRead", "cache_read", "cachedInputTokens"),
  };
}

const addUsage = (acc, u) => {
  if (!acc || !u) return;
  acc.input += u.input ?? 0;
  acc.output += u.output ?? 0;
  acc.cacheRead += u.cacheRead ?? 0;
};

const preview = (v, max = 160) => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
};

// --- shared session plumbing (v1 runNode + v2 openStepSession) ----------------

/** Normalize SDK session events into GUI events; returns { unsubscribe, touch }. */
function attachEventBridge(session, nodeId, onEvent) {
  let lastActivity = Date.now();
  const touch = () => (lastActivity = Date.now());
  const unsubscribe = session.subscribe((evt) => {
    touch();
    switch (evt.type) {
      case "message_update": {
        const e = evt.assistantMessageEvent;
        if (e?.type === "text_delta" && e.delta) onEvent(nodeId, { t: "text", s: e.delta });
        else if (e?.type === "thinking_delta" && e.delta) onEvent(nodeId, { t: "think", s: e.delta });
        break;
      }
      case "tool_execution_start":
        onEvent(nodeId, { t: "tool", name: evt.toolName, args: preview(evt.args ?? evt.input) });
        break;
      case "tool_execution_end":
        onEvent(nodeId, { t: "tool_end", ok: !evt.isError, name: evt.toolName });
        break;
      case "turn_end": {
        const u = normUsage(evt.message?.usage);
        if (u) onEvent(nodeId, { t: "usage", usage: u });
        break;
      }
      case "auto_retry_start":
        onEvent(nodeId, { t: "notice", s: "provider auto-retry" });
        break;
      default:
        break;
    }
  });
  return { unsubscribe, touch, lastActivityRef: () => lastActivity };
}

/** Stall watchdog: abort the session if nothing arrives for stallMs. Returns a
 *  clearer; the caller checks didStall() after prompt() settles. */
const STALL_MS = Number(process.env.NANO_STALL_TIMEOUT_MS ?? 300_000);
function startStallWatchdog(lastActivityRef, onAbort) {
  let stalled = false;
  if (STALL_MS <= 0) return { clear: () => {}, didStall: () => false };
  const timer = setInterval(() => {
    if (Date.now() - lastActivityRef() >= STALL_MS) {
      stalled = true;
      onAbort();
    }
  }, 5_000);
  return { clear: () => clearInterval(timer), didStall: () => stalled };
}

function buildLoader({ cwd, systemPrompt, stepId }) {
  const bundled = bundledSkillsForStep(stepId);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // The driver owns the context — no runtime discovery of anything EXCEPT
    // nano-cycle's own bundled skills (filtered per step in v2).
    systemPromptOverride: () => systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: (current) => ({
      skills: bundled.skills,
      diagnostics: [...(current?.diagnostics ?? []), ...bundled.diagnostics],
    }),
  });
  return loader.reload().then(() => loader);
}

/**
 * Run one node to completion (v1 pipeline + v2 ephemeral children). Returns the
 * reported artifact. onEvent(nodeId, ev) receives normalized UI events.
 */
export async function runNode({ nodeId, tools, customTools = [], artifactStore, requireArtifact = true, systemPrompt, prompt, cwd, modelSpec, modelRuntime, onEvent, signal, thinking, stepId }) {
  const store = artifactStore ?? { artifacts: [] };
  const { model, thinking: lvl } = resolveModel(modelSpec, modelRuntime);
  if (modelSpec && modelSpec !== "auto" && !model) {
    throw new Error(`model "${modelSpec}" did not resolve`);
  }

  const loader = await buildLoader({ cwd, systemPrompt, stepId });

  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    ...(model ? { model } : {}),
    ...(lvl ?? thinking ? { thinkingLevel: lvl ?? thinking } : {}),
    tools, // allowlist is the enforcement
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
  });

  const bridge = attachEventBridge(session, nodeId, onEvent);
  const watchdog = startStallWatchdog(bridge.lastActivityRef, () => session.abort().catch(() => {}));

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        session.abort().catch(() => {});
      },
      { once: true },
    );
  }

  try {
    await session.prompt(prompt);
    // Surface provider-level failures verbatim — a stopReason "error" with no
    // tool call would otherwise masquerade as "model didn't follow the contract".
    const last = session.messages.filter((m) => m.role === "assistant").pop();
    if (last?.stopReason === "error") {
      throw new Error(last.errorMessage ?? "provider call failed");
    }
    if (requireArtifact && store.artifacts.length === 0) {
      onEvent(nodeId, { t: "notice", s: "no report_artifact call — retrying once" });
      await session.prompt(
        "You finished without calling the report_artifact tool. Call it now, EXACTLY ONCE, with the structured result of your work.",
      );
      const last2 = session.messages.filter((m) => m.role === "assistant").pop();
      if (last2?.stopReason === "error") {
        throw new Error(last2.errorMessage ?? "provider call failed");
      }
    }
  } finally {
    watchdog.clear();
    bridge.unsubscribe();
  }
  if (watchdog.didStall() && store.artifacts.length === 0) {
    throw new Error(`stalled: no activity for ${Math.round(STALL_MS / 1000)}s`);
  }

  if (requireArtifact && store.artifacts.length === 0) {
    throw new Error(`${nodeId}: completed without report_artifact`);
  }
  return store.artifacts[store.artifacts.length - 1];
}

/**
 * v2: open (or create) one PERSISTENT step session. The session file lives in
 * `sessionsDir` (runs/<id>/sessions) so the step survives handle close and
 * server restarts — the build step's fix rounds resume THIS session (amendment 1).
 *
 * Returns { session, sessionFile, prompt(text), lastError(), abort(), close() }.
 * - prompt(text): one full model turn; throws on provider error or stall.
 * - The event bridge stays attached for the handle's lifetime; the watchdog is
 *   per-turn. The system prompt comes from the loader on every (re)open, so a
 *   resumed session gets the same (or evolved) step law — see SPIKE-NOTES (e).
 */
export async function openStepSession({ stepId, sessionFile, sessionsDir, tools, customTools = [], systemPrompt, cwd, modelSpec, modelRuntime, onEvent, signal, thinking }) {
  const { model, thinking: lvl } = resolveModel(modelSpec, modelRuntime);
  if (modelSpec && modelSpec !== "auto" && !model) {
    throw new Error(`model "${modelSpec}" did not resolve`);
  }
  const loader = await buildLoader({ cwd, systemPrompt, stepId });

  fs.mkdirSync(sessionsDir, { recursive: true });
  const resume = sessionFile && fs.existsSync(sessionFile);
  const mgr = resume ? SessionManager.open(sessionFile) : SessionManager.create(cwd, sessionsDir);
  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    ...(model ? { model } : {}),
    ...(lvl ?? thinking ? { thinkingLevel: lvl ?? thinking } : {}),
    tools,
    customTools,
    resourceLoader: loader,
    sessionManager: mgr,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
  });
  const file = mgr.getSessionFile();
  if (!file) throw new Error("persistent session did not expose its file (getSessionFile)");

  const bridge = attachEventBridge(session, stepId, onEvent);
  const onAbort = () => session.abort().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  let lastStall = null;
  const prompt = async (text) => {
    const watchdog = startStallWatchdog(bridge.lastActivityRef, () => {
      lastStall = STALL_MS;
      onAbort();
    });
    try {
      await session.prompt(text);
      const last = session.messages.filter((m) => m.role === "assistant").pop();
      if (last?.stopReason === "error") {
        throw new Error(last.errorMessage ?? "provider call failed");
      }
    } finally {
      watchdog.clear();
    }
    if (lastStall && !session.messages.some((m) => m.role === "assistant" && m.stopReason === "end")) {
      throw new Error(`stalled: no activity for ${Math.round(lastStall / 1000)}s`);
    }
  };

  return {
    session,
    sessionFile: file,
    resumed: resume,
    prompt,
    abort: onAbort,
    close: () => {
      bridge.unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export { addUsage };
