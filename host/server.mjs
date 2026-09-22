// Host server — REST + WebSocket + static GUI. Owns the ModelRuntime and the
// pipeline engine; broadcasts normalized node events to connected browsers.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEngine } from "./engine.mjs";
import { MODEL_ROLES_V2 } from "./config.mjs";
import { addProject, loadProjects, removeProject, resolveProject, SANDBOX_DIR } from "./projects.mjs";
import { loadTickets, saveTickets, createTicket, updateTicket, deleteTicket, setQueueConfig, importTickets } from "./tickets.mjs";
import { importFromFile, parseFeaturesMarkdown } from "./backlog.mjs";
import { createQueueManager } from "./queue.mjs";
import * as git from "./git.mjs";
import { makeWebReaderTool, makeWebSearchTool } from "./webtools.mjs";
import { webCapabilities } from "./token-hygiene.mjs";
import { newRunId, runsDir, saveState, appendEvent, listRuns, loadRun } from "./state.mjs";
import { createChatManager } from "./chat.mjs";

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HOST_DIR, "..");
const WEB_DIST = path.join(ROOT_DIR, "web-dist");
const PORT = Number(process.env.PORT ?? 4177);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// --- runtime + engine ---------------------------------------------------------

console.log("[nano-cycle] initializing ModelRuntime…");
const modelRuntime = await ModelRuntime.create();

// Per-model thinking levels for the GUI's level dropdown. pi-ai is a
// transitive dependency (not re-exported by pi-coding-agent); a direct
// file-URL import bypasses the package exports map. Missing → levels simply
// stay absent from /api/models.
let supportedThinkingLevels = null;
try {
  const { pathToFileURL } = await import("node:url");
  const piAiPath = path.join(
    ROOT_DIR,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
  );
  supportedThinkingLevels = (await import(pathToFileURL(piAiPath).href)).getSupportedThinkingLevels ?? null;
} catch {
  supportedThinkingLevels = null;
}

// Optional research capabilities for clarify/plan nodes. SearXNG defaults to
// the endpoint scripts/deploy.sh installs (local docker); webCapabilities()
// probes once per process (shared with the token-hygiene prompt block) and
// disables web tools that don't answer.
const SEARXNG_URL = process.env.NANO_SEARXNG_URL ?? "http://127.0.0.1:8888";
const webCaps = webCapabilities();
const webTools = {
  search: webCaps.search ? makeWebSearchTool(SEARXNG_URL) : null,
  reader: webCaps.reader ? makeWebReaderTool() : null,
};

// The sandbox folder only matters while the sandbox project is registered —
// a removed sandbox stays removed (re-add it from the GUI to bring it back).
if (loadProjects().some((p) => p.name === "sandbox")) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}
fs.mkdirSync(runsDir(), { recursive: true });

// Orphan sweep: runs that a restart killed mid-flight must never linger as
// "running" — mark them so the GUI and the registry tell the truth.
for (const entry of fs.readdirSync(runsDir())) {
  const f = path.join(runsDir(), entry, "state.json");
  if (!fs.existsSync(f)) continue;
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (["running", "awaiting-gate", "awaiting-answers"].includes(s.status)) {
      s.status = "interrupted";
      s.error = s.error ?? "interrupted by server restart";
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    }
  } catch {
    /* skip corrupt */
  }
}
// The sandbox is a subfolder of nano-cycle (type: module) — pin it CommonJS so
// generated .js modules behave like normal Node files regardless of the parent.
const sandboxPkg = path.join(SANDBOX_DIR, "package.json");
if (!fs.existsSync(sandboxPkg)) {
  fs.writeFileSync(
    sandboxPkg,
    JSON.stringify(
      { name: "nano-cycle-sandbox", private: true, version: "0.0.0", type: "commonjs" },
      null,
      2,
    ),
  );
}

const wsClients = new Set();
const emit = {
  state(run) {
    saveState(run.id, run.state);
    broadcast({ type: "state", runId: run.id, state: run.state });
  },
  event(runId, nodeId, ev) {
    const ts = Date.now();
    appendEvent(runId, nodeId, ev, ts);
    broadcast({ type: "event", runId, nodeId, ev: { ...ev, ts } });
  },
};
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wsClients) {
    if (c.readyState === 1) c.send(s);
  }
}

const pipeline = createEngine({ modelRuntime, emit, webTools });
const queueManager = createQueueManager({ engine: pipeline, emit, resolveProject, git, broadcast: (msg) => broadcast(msg) });
// v3: reconcile ticket queues with interrupted runs after a restart — runs the
// sweep below already marked, so reconciliation sees the truth and requeues.
queueManager.recoverAll();
const chatManager = createChatManager({ modelRuntime, broadcast: (msg) => broadcast(msg) });

// --- http ---------------------------------------------------------------------

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (process.env.DEBUG_HTTP) console.log("[http]", req.method, url.pathname);
  try {
    if (url.pathname === "/api/models" && req.method === "GET") {
      const available = await modelRuntime.getAvailable();
      const models = (available ?? []).map((m) => ({
        provider: m.provider,
        id: m.id,
        label: `${m.provider}/${m.id}`,
        ...(supportedThinkingLevels ? { thinkingLevels: supportedThinkingLevels(m) } : {}),
      }));
      return json(res, 200, models);
    }

    if (url.pathname === "/api/roles" && req.method === "GET") {
      return json(res, 200, MODEL_ROLES_V2);
    }

    if (url.pathname === "/api/projects") {
      if (req.method === "GET") return json(res, 200, loadProjects());
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          return json(res, 201, addProject(body));
        } catch (e) {
          return json(res, 400, { error: String(e?.message ?? e) });
        }
      }
    }

    // Registry-only removal: files on disk and historical runs are untouched.
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "DELETE") {
      const name = decodeURIComponent(projectMatch[1]);
      if (pipeline.activeRunFor(name)) {
        return json(res, 409, { ok: false, error: `a run is active on project "${name}" — wait for it to finish or cancel it first` });
      }
      try {
        return json(res, 200, removeProject(name));
      } catch (e) {
        return json(res, 404, { error: String(e?.message ?? e) });
      }
    }

    if (url.pathname === "/api/runs" && req.method === "GET") {
      return json(res, 200, listRuns());
    }

    // --- v3 queue ---
    const queueMatch = url.pathname.match(/^\/api\/queue\/([^/]+)$/);
    if (queueMatch) {
      const projectName = decodeURIComponent(queueMatch[1]);
      if (req.method === "GET") return json(res, 200, loadTickets(projectName));
      if (req.method === "POST") {
        const body = await readBody(req);
        let out;
        switch (body.action) {
          case "clarify":
            // Config FIRST — models/options passed with the wave apply to THIS wave.
            if (body.models || body.options) {
              setQueueConfig(projectName, { models: body.models, options: body.options });
            }
            out = await queueManager.startClarifyWave(projectName, body.ticketIds ?? []);
            break;
          case "release": out = queueManager.release(projectName, body.ticketIds); break;
          case "pause": out = queueManager.pause(projectName); break;
          case "resume": out = queueManager.resume(projectName); break;
          case "retry": out = queueManager.retry(projectName, body.ticketId); break;
          case "reclarify": out = queueManager.reclarify(projectName, body.ticketId); break;
          case "reorder": out = queueManager.reorder(projectName, body.orderedIds ?? []); break;
          case "config": out = { ok: true, config: setQueueConfig(projectName, body) }; break;
          default: return json(res, 400, { error: `unknown queue action "${body.action}"` });
        }
        return json(res, out.ok === false ? 409 : 200, out);
      }
    }

    // PM Inbox: every live answers gate across the project's clarify runs.
    const inboxMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)$/);
    if (inboxMatch && req.method === "GET") {
      const projectName = decodeURIComponent(inboxMatch[1]);
      const items = [];
      for (const entry of fs.readdirSync(runsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const st = JSON.parse(fs.readFileSync(path.join(runsDir(), entry.name, "state.json"), "utf8"));
          if (st.project !== projectName || st.status !== "awaiting-answers" || st.gate?.type !== "answers") continue;
          items.push({
            runId: st.id,
            ticketId: st.ticketId ?? st.options?.ticketId ?? null,
            waveTicketIds: st.wave?.ticketIds ?? null, // v3.1: one PM item for the whole wave
            round: st.gate.round ?? 1,
            questions: st.gate.questions ?? [],
          });
        } catch { /* skip */ }
      }
      items.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
      return json(res, 200, { project: projectName, items });
    }

    // --- v3 ticket store ---
    const ticketsMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)(?:\/([\w.-]+))?$/);
    if (ticketsMatch) {
      const projectName = decodeURIComponent(ticketsMatch[1]);
      let store;
      try { store = loadTickets(projectName); } catch (e) { return json(res, 500, { error: String(e?.message ?? e) }); }
      if (req.method === "GET" && !ticketsMatch[2]) return json(res, 200, store);
      if (req.method === "POST" && !ticketsMatch[2]) {
        const body = await readBody(req);
        try {
          const t = createTicket(projectName, body);
          broadcast({ type: "tickets", project: projectName });
          return json(res, 201, t);
        } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
      }
      if (req.method === "POST" && ticketsMatch[2] === "import") {
        const body = await readBody(req);
        try {
          let parsed;
          if (body.json !== undefined) {
            const arr = typeof body.json === "string" ? JSON.parse(body.json) : body.json;
            if (!Array.isArray(arr) || arr.length === 0) throw new Error("json import needs a non-empty array of {id?, title, description?} tickets");
            parsed = { tickets: arr, sourceDoc: body.sourceDoc ?? null };
          } else if (body.markdown) {
            const tickets = parseFeaturesMarkdown(String(body.markdown));
            if (tickets.length === 0) {
              throw new Error(
                "no feature entries found in the pasted markdown — expected ids like F##/OMNI-###/GM-## on headings (\"## F01 — Title\") or list items (\"- [x] **F01 — Title**\"); " +
                  "other formats: have an agent structure the doc and use the nano-cycle MCP (nano_bulk_create_tickets) or POST a JSON ticket array",
              );
            }
            parsed = { tickets, sourceDoc: body.sourceDoc ?? null };
          } else {
            let projectPath;
            try { projectPath = resolveProject(projectName).path; } catch { return json(res, 400, { error: `unknown project "${projectName}"` }); }
            parsed = importFromFile(projectPath, String(body.path ?? "docs/features.md"));
          }
          // Parse-then-CREATE: the import lands in the store (existing ids skipped).
          const out = importTickets(projectName, parsed);
          broadcast({ type: "tickets", project: projectName });
          return json(res, 200, { ...out, sourceDoc: parsed.sourceDoc });
        } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
      }
      const ticketId = ticketsMatch[2];
      if (req.method === "PATCH" && ticketId) {
        const body = await readBody(req);
        try {
          const t = updateTicket(projectName, ticketId, body);
          broadcast({ type: "tickets", project: projectName });
          return json(res, 200, t);
        } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
      }
      if (req.method === "DELETE" && ticketId) {
        try {
          deleteTicket(projectName, ticketId);
          broadcast({ type: "tickets", project: projectName });
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 404, { error: String(e?.message ?? e) }); }
      }
    }

    if (url.pathname === "/api/runs" && req.method === "POST") {
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      if (!task) return json(res, 400, { error: "task is required" });
      let project;
      try {
        project = resolveProject(String(body.project ?? "sandbox"));
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) });
      }
      const models = {};
      for (const role of Object.keys(MODEL_ROLES_V2)) {
        models[role] = String(body.models?.[role] ?? "auto");
      }
      const securityRaw = String(body.security ?? "off");
      const security = ["off", "scan", "scan+vapt"].includes(securityRaw) ? securityRaw : "off";
      // The sandbox lives INSIDE nano-cycle's own repo — git on it is only safe
      // when the owner made it its own repository (git init); otherwise branch/
      // commit operations would hit nano-cycle's .git.
      let gitRequested = body.git === true;
      if (gitRequested && project.path === SANDBOX_DIR) {
        gitRequested = await (await import("./git.mjs")).isRepo(project.path);
      }
      const id = newRunId();
      const state = await pipeline.start({
        id,
        task,
        project,
        models,
        clarify: !!body.clarify,
        requireQuestions: body.requireQuestions === true,
        maxFixRounds: Number(body.maxFixRounds),
        git: gitRequested,
        audit: body.audit !== false,
        approvePlan: body.approvePlan !== false,
        remoteChecks: body.remoteChecks === true,
        security,
        ticketId: body.ticketId ?? null, // v3: joins the run to its ticket (watcher/Inbox provenance)
        stopAfterClarify: body.stopAfterClarify === true, // v3: park as 'clarified' for queue promotion
      });
      return json(res, 201, state);
    }

    // Specs live OUTSIDE the projects they describe — runs/ is the per-project
    // spec store (state.json → artifacts.spec). This endpoint surfaces them.
    const specMatch = url.pathname.match(/^\/api\/specs\/([\w.-]+)$/);
    if (specMatch && req.method === "GET") {
      const projectName = specMatch[1];
      const found = [];
      for (const entry of fs.readdirSync(runsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const st = JSON.parse(fs.readFileSync(path.join(runsDir(), entry.name, "state.json"), "utf8"));
          if (st.project === projectName && st.artifacts?.spec) {
            found.push({ runId: st.id, createdAt: st.createdAt, tier: st.version === 2 ? `v2/${st.options?.security ?? "-"}` : st.tier, status: st.status, spec: st.artifacts.spec });
          }
        } catch {
          /* unreadable run — skip */
        }
      }
      if (found.length === 0) return json(res, 404, { error: `no specs for project "${projectName}"` });
      found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const latest = found[0];
      if (url.searchParams.get("format") === "md") {
        const spec = latest.spec;
        const md = [
          `# Spec — ${latest.runId}`,
          "",
          `Project: ${projectName} · Mode: ${latest.tier} · Date: ${latest.createdAt}`,
          ...(spec.source_docs?.length ? [`Source docs (their requirements OUTRANK this spec): ${spec.source_docs.join(", ")}`] : []),
          "",
          "## Summary",
          "",
          spec.summary,
          "",
          "## Locked decisions",
          "",
          ...((spec.decisions ?? []).map((d) => `- **${d.topic}**: ${d.decision}`) || ["- (none)"]),
          "",
          "## Acceptance criteria",
          "",
          ...((spec.acceptance_criteria ?? []).map((c) => `- [ ] ${c}`) || ["- (none)"]),
          ...(spec.ac_verification?.length
            ? ["", "## Verification environments", "", ...spec.ac_verification.map((a) => `- [${a.env}] ${a.criterion}`)]
            : []),
          ...(spec.out_of_scope?.length ? ["", "## Out of scope", "", ...spec.out_of_scope.map((o) => `- ${o}`)] : []),
          "",
        ].join("\n");
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(md);
      }
      return json(res, 200, { project: projectName, total: found.length, latest });
    }

    // --- standalone project coding agent chat ---
    const chatMatch = url.pathname.match(/^\/api\/chat\/([^/]+)\/sessions(?:\/([^/]+)(?:\/(message|abort))?)?$/);
    if (chatMatch) {
      const projectName = decodeURIComponent(chatMatch[1]);
      const sessionId = chatMatch[2] ? decodeURIComponent(chatMatch[2]) : null;
      const action = chatMatch[3] || null;

      try {
        if (!sessionId) {
          if (req.method === "GET") {
            const list = await chatManager.listSessions(projectName);
            return json(res, 200, list);
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const sess = await chatManager.createSession(projectName, body);
            return json(res, 201, sess);
          }
        } else if (!action) {
          if (req.method === "GET") {
            const sess = await chatManager.getSession(projectName, sessionId);
            return json(res, 200, sess);
          }
          if (req.method === "DELETE") {
            const out = await chatManager.deleteSession(projectName, sessionId);
            return json(res, 200, out);
          }
          if (req.method === "PATCH") {
            const body = await readBody(req);
            if (body.title) {
              await chatManager.renameSession(projectName, sessionId, body.title);
            }
            return json(res, 200, { ok: true });
          }
        } else if (action === "message" && req.method === "POST") {
          const body = await readBody(req);
          // Kick off agent prompt; events stream via WebSocket.
          chatManager.sendMessage(projectName, sessionId, body).catch((err) => {
            console.error(`[chat error ${projectName}/${sessionId}]`, err);
          });
          return json(res, 200, { ok: true });
        } else if (action === "abort" && req.method === "POST") {
          const out = await chatManager.abortSession(projectName, sessionId);
          return json(res, 200, out);
        }
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/(gate|cancel|answers|model|resume))?$/);
    if (runMatch) {
      const [, id, , action] = runMatch;
      if (req.method === "GET" && !action) {
        try {
          return json(res, 200, loadRun(id));
        } catch {
          return json(res, 404, { error: "not found" });
        }
      }
      if (req.method === "POST" && action === "gate") {
        const body = await readBody(req);
        const ok = pipeline.gate(id, body.action === "cancel" ? "cancel" : body.action === "reject" ? "reject" : "approve", body.comments);
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "answers") {
        const body = await readBody(req);
        const ok = pipeline.answer(id, body.answers ?? {});
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "model") {
        const body = await readBody(req);
        const out = pipeline.setStepModel(id, String(body.step ?? body.node ?? ""), String(body.model ?? "auto"));
        return json(res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && action === "cancel") {
        return json(res, 200, { ok: pipeline.cancel(id) });
      }
      if (req.method === "POST" && action === "resume") {
        const body = await readBody(req);
        const opts = { fix: body.fix === true };
        let out = pipeline.resume(id, opts);
        if (!out.ok && /not active in this server session/.test(String(out.error ?? ""))) {
          // restart recovery: rebuild the controller from runs/<id>/state.json
          out = pipeline.resumeFromDisk(id, undefined, opts);
        }
        return json(res, out.ok ? 200 : 409, out);
      }
    }

    // static GUI with SPA fallback
    let file = path.join(WEB_DIST, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(WEB_DIST)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(WEB_DIST, "index.html");
    }
    if (!fs.existsSync(file)) {
      return json(res, 503, { error: "GUI not built — run: npm run build" });
    }
    // HTML must revalidate (it references hashed assets by name); hashed
    // assets are immutable and cacheable forever.
    const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    headers["cache-control"] = file.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", (c) => {
  wsClients.add(c);
  c.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "chat_abort" && msg.project && msg.sessionId) {
        await chatManager.abortSession(msg.project, msg.sessionId);
      }
    } catch {
      /* non-json or unhandled */
    }
  });
  c.on("close", () => wsClients.delete(c));
});

const HOST = process.env.NANO_HOST ?? "127.0.0.1"; // loopback by default — set NANO_HOST=0.0.0.0 behind a reverse proxy
server.listen(PORT, HOST, () => {
  console.log(`[nano-cycle] http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}${HOST === "0.0.0.0" ? " (bound to all interfaces — use a reverse proxy + TLS)" : ""}`);
  console.log(`[nano-cycle] projects: ${loadProjects().map((p) => p.name).join(", ")}`);
});
