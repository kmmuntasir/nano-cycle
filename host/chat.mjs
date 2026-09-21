// Project standalone coding agent manager — powers the Chat tab.
// Creates, resumes, manages and streams sessions using @earendil-works/pi-coding-agent.
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveProject } from "./projects.mjs";

/** Normalize usage fields from pi SDK. */
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
    cacheWrite: g("cacheWrite", "cache_write"),
    total: g("totalTokens", "total"),
    cost: u.cost ?? null,
  };
}

/**
 * Format raw SessionManager entries into client-friendly messages.
 * Matches assistant toolCalls with their corresponding toolResults.
 */
export function formatSessionEntries(entries) {
  const toolResults = new Map();
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "toolResult") {
      const content = Array.isArray(e.message.content)
        ? e.message.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
        : typeof e.message.content === "string"
        ? e.message.content
        : "";
      toolResults.set(e.message.toolCallId, {
        toolCallId: e.message.toolCallId,
        toolName: e.message.toolName,
        isError: !!e.message.isError,
        content,
        details: e.message.details ?? null,
        timestamp: e.message.timestamp || (e.timestamp ? Date.parse(e.timestamp) : Date.now()),
      });
    }
  }

  const messages = [];
  let currentModel = null;
  let currentThinkingLevel = null;
  let sessionTitle = null;

  for (const e of entries) {
    if (e.type === "model_change") {
      currentModel = e.modelId ? `${e.provider ? e.provider + "/" : ""}${e.modelId}` : null;
    } else if (e.type === "thinking_level_change") {
      currentThinkingLevel = e.thinkingLevel ?? null;
    } else if (e.type === "session_info" && e.name) {
      sessionTitle = e.name;
    } else if (e.type === "message") {
      const m = e.message;
      if (!m) continue;

      if (m.role === "user") {
        const text = Array.isArray(m.content)
          ? m.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
          : typeof m.content === "string"
          ? m.content
          : "";
        messages.push({
          id: e.id,
          role: "user",
          timestamp: m.timestamp || (e.timestamp ? Date.parse(e.timestamp) : Date.now()),
          content: text,
        });
      } else if (m.role === "assistant") {
        let thinking = "";
        let text = "";
        const toolCalls = [];

        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "thinking") {
              thinking += (thinking ? "\n" : "") + (c.thinking ?? "");
            } else if (c.type === "text") {
              text += (text ? "\n" : "") + (c.text ?? "");
            } else if (c.type === "toolCall") {
              const res = toolResults.get(c.id) ?? null;
              toolCalls.push({
                id: c.id,
                name: c.name,
                arguments: c.arguments ?? c.input ?? {},
                result: res,
              });
            }
          }
        } else if (typeof m.content === "string") {
          text = m.content;
        }

        messages.push({
          id: e.id,
          role: "assistant",
          timestamp: m.timestamp || (e.timestamp ? Date.parse(e.timestamp) : Date.now()),
          model: m.model ? `${m.provider ? m.provider + "/" : ""}${m.model}` : currentModel,
          thinking,
          content: text,
          toolCalls,
          usage: normUsage(m.usage),
          stopReason: m.stopReason ?? null,
        });
      }
    }
  }

  return { messages, currentModel, currentThinkingLevel, sessionTitle };
}

export function createChatManager({ modelRuntime, broadcast }) {
  // In-memory active sessions: sessionId -> { session, project, unsubscribe, isGenerating, abortController }
  const activeSessions = new Map();

  function getProject(projectName) {
    return resolveProject(projectName);
  }

  /** List all sessions for a project. */
  async function listSessions(projectName) {
    const project = getProject(projectName);
    const rawList = await SessionManager.list(project.path);
    return rawList.map((item) => ({
      id: item.id,
      file: item.path,
      name: item.name || null,
      firstMessage: item.firstMessage ? item.firstMessage.slice(0, 100) : null,
      messageCount: item.messageCount ?? 0,
      createdAt: item.created ? new Date(item.created).toISOString() : null,
      modifiedAt: item.modified ? new Date(item.modified).toISOString() : null,
    }));
  }

  /** Find the session file path for a sessionId within a project. */
  async function findSessionFile(projectPath, sessionId) {
    const list = await SessionManager.list(projectPath);
    const match = list.find((s) => s.id === sessionId);
    if (match) return match.path;
    return null;
  }

  /** Load session details and history. */
  async function getSession(projectName, sessionId) {
    const project = getProject(projectName);

    // If already active in memory
    const active = activeSessions.get(sessionId);
    if (active) {
      const sm = active.session.sessionManager;
      const entries = sm.getEntries();
      const formatted = formatSessionEntries(entries);
      return {
        id: sessionId,
        file: sm.getSessionFile(),
        title: formatted.sessionTitle || sm.getSessionName() || null,
        model: active.session.model ? `${active.session.model.provider}/${active.session.model.id}` : formatted.currentModel,
        thinkingLevel: active.session.thinkingLevel ?? formatted.currentThinkingLevel,
        messages: formatted.messages,
        isGenerating: !!active.isGenerating,
      };
    }

    // Otherwise load from file
    const sessionFile = await findSessionFile(project.path, sessionId);
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      throw new Error(`Session "${sessionId}" not found in project "${projectName}"`);
    }

    const sm = SessionManager.open(sessionFile);
    const entries = sm.getEntries();
    const formatted = formatSessionEntries(entries);

    return {
      id: sessionId,
      file: sessionFile,
      title: formatted.sessionTitle || sm.getSessionName() || null,
      model: formatted.currentModel,
      thinkingLevel: formatted.currentThinkingLevel,
      messages: formatted.messages,
      isGenerating: false,
    };
  }

  /** Create a new session. */
  async function createSession(projectName, { modelSpec, thinkingLevel, title } = {}) {
    const project = getProject(projectName);
    const sm = SessionManager.create(project.path);
    const sessionId = sm.getSessionId();

    if (title) {
      sm.appendSessionInfo(String(title).trim());
    }

    // Set up active agent session immediately so model/thinking are configured
    await getOrCreateSession(projectName, sessionId, { modelSpec, thinkingLevel, sessionManager: sm });

    return {
      id: sessionId,
      file: sm.getSessionFile(),
      title: title ?? null,
      model: modelSpec ?? "auto",
      thinkingLevel: thinkingLevel ?? null,
    };
  }

  /** Delete a session. */
  async function deleteSession(projectName, sessionId) {
    const project = getProject(projectName);
    const active = activeSessions.get(sessionId);
    if (active) {
      try {
        active.session.abort().catch(() => {});
        active.unsubscribe?.();
      } catch {
        /* ignore */
      }
      activeSessions.delete(sessionId);
    }

    const sessionFile = await findSessionFile(project.path, sessionId);
    if (sessionFile && fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      return { ok: true };
    }
    return { ok: true, note: "file was already removed or in-memory" };
  }

  /** Rename / set title for a session. */
  async function renameSession(projectName, sessionId, newTitle) {
    const project = getProject(projectName);
    const title = String(newTitle ?? "").trim();
    if (!title) throw new Error("title cannot be empty");

    const active = activeSessions.get(sessionId);
    if (active) {
      active.session.sessionManager.appendSessionInfo(title);
      return { ok: true, title };
    }

    const sessionFile = await findSessionFile(project.path, sessionId);
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const sm = SessionManager.open(sessionFile);
    sm.appendSessionInfo(title);
    return { ok: true, title };
  }

  /** Get or initialize an active AgentSession instance. */
  async function getOrCreateSession(projectName, sessionId, { modelSpec, thinkingLevel, sessionManager } = {}) {
    let active = activeSessions.get(sessionId);
    if (active) {
      // If modelSpec is requested and different, update it
      if (modelSpec && modelSpec !== "auto") {
        try {
          const parsed = resolveCliModel({ cliModel: modelSpec, modelRuntime });
          if (parsed?.model) {
            await active.session.setModel(parsed.model);
          }
        } catch (e) {
          console.warn(`[chat] failed to set model "${modelSpec}":`, e.message);
        }
      }
      if (thinkingLevel !== undefined && active.session.setThinkingLevel) {
        active.session.setThinkingLevel(thinkingLevel);
      }
      return active;
    }

    const project = getProject(projectName);
    let sm = sessionManager;
    if (!sm) {
      const sessionFile = await findSessionFile(project.path, sessionId);
      if (sessionFile && fs.existsSync(sessionFile)) {
        sm = SessionManager.open(sessionFile);
      } else {
        sm = SessionManager.create(project.path);
      }
    }

    // Resolve model if requested
    let model = undefined;
    let resolvedThinking = thinkingLevel;
    if (modelSpec && modelSpec !== "auto") {
      try {
        const parsed = resolveCliModel({ cliModel: modelSpec, modelRuntime });
        if (parsed?.model) model = parsed.model;
        if (parsed?.thinking) resolvedThinking = parsed.thinking;
      } catch (e) {
        console.warn(`[chat] failed to resolve model "${modelSpec}":`, e.message);
      }
    }

    const loader = new DefaultResourceLoader({
      cwd: project.path,
      agentDir: getAgentDir(),
    });
    await loader.reload().catch(() => {});

    const { session } = await createAgentSession({
      cwd: project.path,
      modelRuntime,
      ...(model ? { model } : {}),
      ...(resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
      resourceLoader: loader,
      sessionManager: sm,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
    });

    // Make sure standard coding tools are enabled
    try {
      session.setActiveToolsByName(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    } catch {
      /* fallback to defaults */
    }

    // Attach event subscriber for real-time WebSocket broadcasting
    const unsubscribe = session.subscribe((evt) => {
      switch (evt.type) {
        case "message_update": {
          const e = evt.assistantMessageEvent;
          if (e?.type === "text_delta" && e.delta) {
            broadcast({
              type: "chat_event",
              event: "text_delta",
              project: projectName,
              sessionId,
              delta: e.delta,
            });
          } else if (e?.type === "thinking_delta" && e.delta) {
            broadcast({
              type: "chat_event",
              event: "thinking_delta",
              project: projectName,
              sessionId,
              delta: e.delta,
            });
          }
          break;
        }
        case "tool_execution_start": {
          broadcast({
            type: "chat_event",
            event: "tool_start",
            project: projectName,
            sessionId,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            args: evt.args ?? evt.input ?? {},
          });
          break;
        }
        case "tool_execution_update": {
          broadcast({
            type: "chat_event",
            event: "tool_update",
            project: projectName,
            sessionId,
            toolCallId: evt.toolCallId,
            partialResult: evt.partialResult,
          });
          break;
        }
        case "tool_execution_end": {
          const content = Array.isArray(evt.result?.content)
            ? evt.result.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
            : typeof evt.result?.content === "string"
            ? evt.result.content
            : "";
          broadcast({
            type: "chat_event",
            event: "tool_end",
            project: projectName,
            sessionId,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            ok: !evt.isError,
            content,
            details: evt.result?.details ?? null,
          });
          break;
        }
        case "turn_end": {
          const u = normUsage(evt.message?.usage);
          broadcast({
            type: "chat_event",
            event: "turn_end",
            project: projectName,
            sessionId,
            usage: u,
            message: evt.message,
          });
          break;
        }
        default:
          break;
      }
    });

    active = {
      session,
      project: projectName,
      sessionId,
      unsubscribe,
      isGenerating: false,
    };
    activeSessions.set(sessionId, active);
    return active;
  }

  /** Send a message turn to the coding agent session. */
  async function sendMessage(projectName, sessionId, { prompt, modelSpec, thinkingLevel }) {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("prompt cannot be empty");

    const active = await getOrCreateSession(projectName, sessionId, { modelSpec, thinkingLevel });
    if (active.isGenerating) {
      throw new Error("Agent is already working on a message in this session");
    }

    active.isGenerating = true;

    // Auto-name session if it doesn't have a title yet
    const sm = active.session.sessionManager;
    if (!sm.getSessionName()) {
      const autoTitle = text.slice(0, 50).replace(/[\r\n]+/g, " ");
      sm.appendSessionInfo(autoTitle);
      broadcast({
        type: "chat_event",
        event: "session_renamed",
        project: projectName,
        sessionId,
        title: autoTitle,
      });
    }

    broadcast({
      type: "chat_event",
      event: "prompt_start",
      project: projectName,
      sessionId,
      prompt: text,
      timestamp: Date.now(),
    });

    try {
      await active.session.prompt(text);

      const last = active.session.messages.filter((m) => m.role === "assistant").pop();
      if (last?.stopReason === "error") {
        throw new Error(last.errorMessage ?? "Provider call failed");
      }

      broadcast({
        type: "chat_event",
        event: "prompt_end",
        project: projectName,
        sessionId,
      });
      return { ok: true };
    } catch (err) {
      broadcast({
        type: "chat_event",
        event: "error",
        project: projectName,
        sessionId,
        error: String(err?.message ?? err),
      });
      throw err;
    } finally {
      active.isGenerating = false;
    }
  }

  /** Abort currently running generation or tool execution. */
  async function abortSession(projectName, sessionId) {
    const active = activeSessions.get(sessionId);
    if (!active) return { ok: false, error: "session is not active" };

    try {
      await active.session.abort();
    } catch (e) {
      console.warn("[chat] error aborting session:", e.message);
    }
    active.isGenerating = false;
    broadcast({
      type: "chat_event",
      event: "aborted",
      project: projectName,
      sessionId,
    });
    return { ok: true };
  }

  return {
    listSessions,
    getSession,
    createSession,
    deleteSession,
    renameSession,
    sendMessage,
    abortSession,
  };
}
