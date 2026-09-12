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
import { addProject, loadProjects, resolveProject, SANDBOX_DIR } from "./projects.mjs";
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

// Optional research capabilities for clarify/plan nodes.
const searxngUrl = process.env.NANO_SEARXNG_URL;
const webCaps = detectWebCapabilities(searxngUrl);
const webTools = {
  search: webCaps.search ? makeWebSearchTool(searxngUrl) : null,
  reader: webCaps.reader ? makeWebReaderTool() : null,
};

fs.mkdirSync(SANDBOX_DIR, { recursive: true });
fs.mkdirSync(runsDir(), { recursive: true });
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
    appendEvent(runId, nodeId, ev);
    broadcast({ type: "event", runId, nodeId, ev });
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
  res.writeHead(code, { "content-type": "application/json" });
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
      const state = pipeline.start({
        id,
        task,
        tier,
        project,
        models,
        clarify: !!body.clarify,
        requireQuestions: body.requireQuestions === true,
        maxFixRounds: Number(body.maxFixRounds),
      });
      return json(res, 201, state);
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/(gate|cancel|answers))?$/);
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
      if (req.method === "POST" && action === "cancel") {
        return json(res, 200, { ok: pipeline.cancel(id) });
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
