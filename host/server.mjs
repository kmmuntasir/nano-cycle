// Host server — REST + WebSocket + static GUI. Owns the ModelRuntime and the
// pipeline engine; broadcasts normalized node events to connected browsers.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPipeline } from "./pipeline.mjs";
import { DEFAULT_TIER, MODEL_ROLES, TIERS } from "./config.mjs";
import { addProject, loadProjects, removeProject, resolveProject, SANDBOX_DIR } from "./projects.mjs";
import { detectWebCapabilities, makeWebReaderTool, makeWebSearchTool } from "./webtools.mjs";
import { newRunId, runsDir, saveState, appendEvent, listRuns, loadRun } from "./state.mjs";

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

// Optional research capabilities for clarify/plan nodes.
const searxngUrl = process.env.NANO_SEARXNG_URL;
const webCaps = detectWebCapabilities(searxngUrl);
const webTools = {
  search: webCaps.search ? makeWebSearchTool(searxngUrl) : null,
  reader: webCaps.reader ? makeWebReaderTool() : null,
};

fs.mkdirSync(SANDBOX_DIR, { recursive: true });
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

const pipeline = createPipeline({ modelRuntime, emit, webTools });

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

    if (url.pathname === "/api/tiers" && req.method === "GET") {
      const tiers = Object.fromEntries(
        Object.entries(TIERS).map(([t, nodes]) => [t, nodes.map((n) => n.id)]),
      );
      return json(res, 200, tiers);
    }

    if (url.pathname === "/api/roles" && req.method === "GET") {
      return json(res, 200, MODEL_ROLES);
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

    if (url.pathname === "/api/runs" && req.method === "POST") {
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      if (!task) return json(res, 400, { error: "task is required" });
      const tier = TIERS[body.tier] ? body.tier : DEFAULT_TIER;
      let project;
      try {
        project = resolveProject(String(body.project ?? "sandbox"));
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) });
      }
      const models = {};
      for (const role of Object.keys(MODEL_ROLES)) {
        models[role] = String(body.models?.[role] ?? "auto");
      }
      const id = newRunId();
      const state = await pipeline.start({
        id,
        task,
        tier,
        project,
        models,
        clarify: !!body.clarify,
        requireQuestions: body.requireQuestions === true,
        maxFixRounds: Number(body.maxFixRounds),
        git: body.git === true && project.path !== SANDBOX_DIR,
        audit: body.audit !== false,
        approvePlan: body.approvePlan !== false,
        remoteChecks: body.remoteChecks === true,
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
            found.push({ runId: st.id, createdAt: st.createdAt, tier: st.tier, status: st.status, spec: st.artifacts.spec });
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
          `Project: ${projectName} · Tier: ${latest.tier} · Date: ${latest.createdAt}`,
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
        const ok = pipeline.gate(id, body.action === "cancel" ? "cancel" : "approve");
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "answers") {
        const body = await readBody(req);
        const ok = pipeline.answer(id, body.answers ?? {});
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "model") {
        const body = await readBody(req);
        const out = pipeline.setNodeModel(id, String(body.node ?? ""), String(body.model ?? "auto"));
        return json(res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && action === "cancel") {
        return json(res, 200, { ok: pipeline.cancel(id) });
      }
      if (req.method === "POST" && action === "resume") {
        const out = pipeline.resume(id);
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
  c.on("close", () => wsClients.delete(c));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[nano-cycle] http://127.0.0.1:${PORT}`);
  console.log(`[nano-cycle] projects: ${loadProjects().map((p) => p.name).join(", ")}`);
});
