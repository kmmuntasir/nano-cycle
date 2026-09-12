// Node runner — one pi SDK AgentSession per node. The driver owns 100% of the
// context: system prompt override, zero context-file/skill discovery, explicit
// tool allowlists, schema'd report_artifact for structured output.
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

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

/** Generic structured-output tool factory (clarify phase uses ask/finalize tools). */
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

/**
 * Run one node to completion. Returns the reported artifact.
 * onEvent(nodeId, ev) receives normalized UI events.
 * tools = allowlist strings; customTools = tool definitions (their names must
 * appear in `tools` to be reachable).
 */
export async function runNode({ nodeId, tools, customTools = [], artifactStore, requireArtifact = true, systemPrompt, prompt, cwd, modelSpec, modelRuntime, onEvent, signal, thinking }) {
  const store = artifactStore ?? { artifacts: [] };
  const { model, thinking: lvl } = resolveModel(modelSpec, modelRuntime);
  if (modelSpec && modelSpec !== "auto" && !model) {
    throw new Error(`model "${modelSpec}" did not resolve`);
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // The driver owns the context — no runtime discovery of anything.
    systemPromptOverride: () => systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: (current) => ({ skills: [], diagnostics: current?.diagnostics ?? [] }),
  });
  await loader.reload();

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

  // Stall watchdog: a provider connection can hang mid-stream with no events.
  // If nothing arrives for stallMs, abort the attempt — execNode retries it.
  const stallMs = Number(process.env.NANO_STALL_TIMEOUT_MS ?? 300_000);
  let lastActivity = Date.now();
  let stalled = false;
  const touch = () => (lastActivity = Date.now());
  const stallTimer =
    stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastActivity >= stallMs) {
            stalled = true;
            onEvent(nodeId, {
              t: "notice",
              s: `stalled: no activity for ${Math.round(stallMs / 1000)}s — aborting attempt`,
            });
            session.abort().catch(() => {});
          }
        }, 5_000)
      : null;

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
    if (stallTimer) clearInterval(stallTimer);
    unsubscribe();
  }
  if (stalled && store.artifacts.length === 0) {
    throw new Error(`stalled: no activity for ${Math.round(stallMs / 1000)}s`);
  }

  if (requireArtifact && store.artifacts.length === 0) {
    throw new Error(`${nodeId}: completed without report_artifact`);
  }
  return store.artifacts[store.artifacts.length - 1];
}

export { addUsage };
