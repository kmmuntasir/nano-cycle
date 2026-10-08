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
import { webCapabilities, warmCapabilities } from "./token-hygiene.mjs";
import { newRunId, runsDir, saveState, appendEvent, listRuns, loadRun, flushAll, readRunState, discardRun } from "./state.mjs";
import { createChatManager } from "./chat.mjs";
import { createAuth, loadOrCreateToken, loginPageHtml, continuePageHtml } from "./auth.mjs";

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HOST_DIR, "..");
const WEB_DIST = path.join(ROOT_DIR, "web-dist");
// Port rule: NANO_PORT, else PORT, else 4177 (the NANO_ name wins so a stray
// PORT from the environment can't override the project's own setting).
const PORT = Number(process.env.NANO_PORT ?? process.env.PORT ?? 4177);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`[nano-cycle] invalid port "${process.env.NANO_PORT ?? process.env.PORT}"`);
  process.exit(1);
}
const HOST = process.env.NANO_HOST ?? "127.0.0.1"; // loopback by default; see README "Homelab deployment"
const MAX_BODY_BYTES = Number(process.env.NANO_MAX_BODY_BYTES ?? 5 * 1024 * 1024);
// Public URL the owner reaches the GUI at (reverse proxy / tailscale serve) —
// only used for the printed login link and the "exposed without TLS" warning.
const PUBLIC_URL = (process.env.NANO_PUBLIC_URL ?? "").replace(/\/$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// --- auth -----------------------------------------------------------------------

const tokenInfo = loadOrCreateToken();
const auth = createAuth({ token: tokenInfo.token });

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
await warmCapabilities(); // async probes prime the caches; keeps boot off the sync-exec path
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const JSON_CT = /^application\/json\s*(;|$)/i;
const hasBody = (req) =>
  req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) > 0 : req.headers["transfer-encoding"] !== undefined;

/** Read a raw request body, capped (413 past MAX_BODY_BYTES). */
function readRaw(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      return reject(new HttpError(413, `request body too large (max ${limit} bytes)`));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body too large (max ${limit} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Parse the JSON body into a plain object. Content type was already enforced
 *  (415) before routing, so text/plain "simple request" bodies never get here. */
async function readBody(req) {
  const data = await readRaw(req);
  if (!data) return {};
  let body;
  try {
    body = JSON.parse(data);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return body;
}

// Basic body schema check: { field: "string" | "string?" | "boolean?" ... }.
// A trailing "?" makes the field optional (null counts as absent).
const TYPES = {
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};
function expect(body, shape) {
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith("?");
    const type = optional ? spec.slice(0, -1) : spec;
    const v = body[key];
    if (v === undefined || v === null) {
      if (optional) continue;
      throw new HttpError(400, `"${key}" is required (${type})`);
    }
    if (!TYPES[type](v)) throw new HttpError(400, `"${key}" must be a ${type}`);
  }
  return body;
}

/** Project names double as URL segments and file names — keep them tame. */
const PROJECT_NAME_RE = /^[\w.@-][\w.@ -]{0,79}$/;

/** Registry-only project lookup. Requests name a registered project; they never
 *  supply a path (resolveProject() would accept any absolute directory). */
function registryProject(name) {
  const n = String(name ?? "");
  if (!PROJECT_NAME_RE.test(n)) throw new HttpError(400, "invalid project name");
  const project = loadProjects().find((p) => p.name === n);
  if (!project) throw new HttpError(400, `unknown project: ${n}`);
  return project;
}
/** Name-shape check only — for read routes and ticket stores of since-removed projects. */
function projectNameParam(raw) {
  let n;
  try { n = decodeURIComponent(raw); } catch { throw new HttpError(400, "invalid project name"); }
  if (!PROJECT_NAME_RE.test(n)) throw new HttpError(400, "invalid project name");
  return n;
}

function html(res, code, body, extra = {}) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}
const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** /login and /logout — the only unauthenticated, non-health pages. */
async function handleLogin(req, res, url) {
  if (url.pathname === "/logout") {
    if (req.method !== "POST") return json(res, 405, { error: "use POST" });
    res.writeHead(303, { location: "/login", "set-cookie": auth.clearCookie(req), "cache-control": "no-store" });
    return res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (auth.authenticate(req) === "ok") {
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      return res.end();
    }
    if (url.searchParams.has("token")) return tokenLink(req, res, url);
    return html(res, 200, loginPageHtml(), { "content-security-policy": LOGIN_CSP });
  }
  if (req.method === "POST") {
    // Login accepts a classic form post (no JS needed) or {"token": "..."} JSON.
    let presented = "";
    const ct = String(req.headers["content-type"] ?? "");
    const raw = await readRaw(req, 8 * 1024);
    if (JSON_CT.test(ct)) {
      try { presented = String(JSON.parse(raw)?.token ?? ""); } catch { throw new HttpError(400, "request body is not valid JSON"); }
    } else if (/^application\/x-www-form-urlencoded/i.test(ct)) {
      presented = new URLSearchParams(raw).get("token") ?? "";
    } else {
      throw new HttpError(415, "login expects a form post or application/json");
    }
    const wantsJson = JSON_CT.test(ct);
    const verdict = auth.checkLogin(req, presented);
    if (verdict === "ok") {
      const headers = { "set-cookie": auth.sessionCookie(req), "cache-control": "no-store" };
      if (wantsJson) {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(303, { ...headers, location: "/" });
      return res.end();
    }
    if (verdict === "limited") {
      const wait = auth.retryAfter(req);
      const msg = `Too many failed attempts - try again in ${Math.ceil(wait / 60)} min.`;
      if (wantsJson) return json(res, 429, { error: msg });
      return html(res, 429, loginPageHtml({ error: msg }), { "retry-after": String(wait), "content-security-policy": LOGIN_CSP });
    }
    if (wantsJson) return json(res, 401, { error: "invalid token" });
    return html(res, 401, loginPageHtml({ error: "Invalid token." }), { "content-security-policy": LOGIN_CSP });
  }
  return json(res, 405, { error: "method not allowed" });
}

/** One-time login link: /?token=... or /login?token=... sets the cookie, then lands on "/". */
function tokenLink(req, res, url) {
  const verdict = auth.checkLogin(req, url.searchParams.get("token"));
  if (verdict === "ok") {
    return html(res, 200, continuePageHtml("/"), { "set-cookie": auth.sessionCookie(req), "referrer-policy": "no-referrer" });
  }
  if (verdict === "limited") {
    return html(res, 429, loginPageHtml({ error: "Too many failed attempts - try again later." }), {
      "retry-after": String(auth.retryAfter(req)),
      "content-security-policy": LOGIN_CSP,
    });
  }
  return html(res, 401, loginPageHtml({ error: "That login link is invalid." }), { "content-security-policy": LOGIN_CSP });
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (process.env.DEBUG_HTTP) console.log("[http]", req.method, url.pathname);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "same-origin");
  try {
    // Uptime probe: unauthenticated, reveals nothing.
    if (url.pathname === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
      return json(res, 200, { ok: true });
    }
    if (!auth.hostOk(req)) throw new HttpError(421, "host not allowed (NANO_ALLOWED_HOSTS)");
    // CSRF: browsers attach Origin to cross-origin writes. Checked before auth
    // so a forged request never even reaches credential handling.
    if (WRITE_METHODS.has(req.method) && !auth.originOk(req)) throw new HttpError(403, "cross-origin request rejected");
    // Bodies are JSON only (a text/plain body is a CORS-preflight-free "simple" request).
    if (WRITE_METHODS.has(req.method) && hasBody(req) && url.pathname !== "/login" && !JSON_CT.test(String(req.headers["content-type"] ?? ""))) {
      throw new HttpError(415, "content-type must be application/json");
    }

    if (url.pathname === "/login" || url.pathname === "/logout") return await handleLogin(req, res, url);

    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    // `/?token=...` one-time link (browsers can't set an Authorization header).
    if (!isApi && req.method === "GET" && url.searchParams.has("token")) return tokenLink(req, res, url);

    const verdict = auth.authenticate(req);
    if (verdict !== "ok") {
      if (verdict === "limited") {
        res.setHeader("retry-after", String(auth.retryAfter(req)));
        return json(res, 429, { error: "too many failed attempts", login: "/login" });
      }
      if (isApi) return json(res, 401, { error: "unauthorized", login: "/login" });
      res.writeHead(302, { location: "/login", "cache-control": "no-store" });
      return res.end();
    }

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
        const body = expect(await readBody(req), { name: "string", path: "string" });
        if (!PROJECT_NAME_RE.test(body.name.trim())) return json(res, 400, { error: "invalid project name" });
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
      const name = projectNameParam(projectMatch[1]);
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
      const projectName = projectNameParam(queueMatch[1]);
      if (req.method === "GET") return json(res, 200, loadTickets(projectName));
      if (req.method === "POST") {
        registryProject(projectName);
        const body = expect(await readBody(req), { action: "string", ticketIds: "array?", ticketId: "string?", orderedIds: "array?", models: "object?", options: "object?" });
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
      const projectName = projectNameParam(inboxMatch[1]);
      const items = [];
      flushAll(); // state writes are buffered — read-your-writes before scanning
      for (const entry of fs.readdirSync(runsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const st = readRunState(entry.name);
          if (!st || st.project !== projectName || st.status !== "awaiting-answers" || st.gate?.type !== "answers") continue;
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
      const projectName = projectNameParam(ticketsMatch[1]);
      let store;
      try { store = loadTickets(projectName); } catch (e) { return json(res, 500, { error: String(e?.message ?? e) }); }
      if (req.method === "GET" && !ticketsMatch[2]) return json(res, 200, store);
      if (req.method === "POST" && !ticketsMatch[2]) {
        registryProject(projectName);
        const body = expect(await readBody(req), { title: "string" });
        try {
          const t = createTicket(projectName, body);
          broadcast({ type: "tickets", project: projectName });
          return json(res, 201, t);
        } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
      }
      if (req.method === "POST" && ticketsMatch[2] === "import") {
        registryProject(projectName);
        const body = expect(await readBody(req), { markdown: "string?", path: "string?", sourceDoc: "string?" });
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
        registryProject(projectName);
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
      const body = expect(await readBody(req), {
        task: "string", project: "string?", models: "object?", clarify: "boolean?", requireQuestions: "boolean?",
        maxFixRounds: "number?", git: "boolean?", audit: "boolean?", approvePlan: "boolean?", remoteChecks: "boolean?",
        security: "string?", ticketId: "string?", stopAfterClarify: "boolean?",
      });
      const task = body.task.trim();
      if (!task) return json(res, 400, { error: "task is required" });
      // Registered projects only — never an absolute path from the request.
      const project = registryProject(body.project ?? "sandbox");
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
      // Q-H4: "Run now" on a ticket goes through the queue manager so the
      // ticket tracks the run (running → done/blocked, dependents, backlog flip).
      let adopted = null;
      if (body.ticketId) {
        adopted = queueManager.adoptDirectRun(project.name, String(body.ticketId), id);
        if (!adopted.ok) return json(res, 409, { error: adopted.error });
      }
      let state;
      try {
      state = await pipeline.start({
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
        onSettled: adopted?.onSettled,
      });
      } catch (e) {
        adopted?.revert();
        throw e;
      }
      return json(res, 201, state);
    }

    // Specs live OUTSIDE the projects they describe — runs/ is the per-project
    // spec store (state.json → artifacts.spec). This endpoint surfaces them.
    const specMatch = url.pathname.match(/^\/api\/specs\/([\w.-]+)$/);
    if (specMatch && req.method === "GET") {
      const projectName = projectNameParam(specMatch[1]);
      const found = [];
      flushAll();
      for (const entry of fs.readdirSync(runsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const st = readRunState(entry.name);
          if (st && st.project === projectName && st.artifacts?.spec) {
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
      const projectName = projectNameParam(chatMatch[1]);
      const sessionId = chatMatch[2] ? decodeURIComponent(chatMatch[2]) : null;
      const action = chatMatch[3] || null;
      registryProject(projectName);

      try {
        if (!sessionId) {
          if (req.method === "GET") {
            const list = await chatManager.listSessions(projectName);
            return json(res, 200, list);
          }
          if (req.method === "POST") {
            const body = expect(await readBody(req), { modelSpec: "string?", thinkingLevel: "string?", title: "string?" });
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
            const body = expect(await readBody(req), { title: "string?" });
            if (body.title) {
              await chatManager.renameSession(projectName, sessionId, body.title);
            }
            return json(res, 200, { ok: true });
          }
        } else if (action === "message" && req.method === "POST") {
          const body = expect(await readBody(req), { prompt: "string", modelSpec: "string?", thinkingLevel: "string?" });
          // Validation/session errors reject here and reach the client; the turn
          // itself runs in the background and streams over the WebSocket.
          const { done } = await chatManager.sendMessage(projectName, sessionId, body);
          done.catch((err) => {
            console.error(`[chat error ${projectName}/${sessionId}]`, err);
          });
          return json(res, 200, { ok: true });
        } else if (action === "abort" && req.method === "POST") {
          const out = await chatManager.abortSession(projectName, sessionId);
          return json(res, 200, out);
        }
      } catch (err) {
        return json(res, err?.status ?? 400, { error: String(err?.message ?? err) });
      }
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/(gate|cancel|answers|model|resume))?$/);
    if (runMatch) {
      const [, id, , action] = runMatch;
      if (req.method === "GET" && !action) {
        try {
          return json(res, 200, loadRun(id));
        } catch (e) {
          if (e?.code === "EUNREADABLE") return json(res, 500, { error: String(e.message), code: "EUNREADABLE" });
          return json(res, 404, { error: "not found" });
        }
      }
      if (req.method === "DELETE" && !action) {
        // Delete a finished run and its whole directory (state, events,
        // sessions). Live runs are refused — cancel them first.
        try {
          const st = loadRun(id);
          if (["running", "awaiting-gate", "awaiting-answers"].includes(st.status)) {
            return json(res, 409, { error: "run is still active — cancel it before deleting" });
          }
        } catch (e) {
          // a corrupt state.json must stay deletable — that's the only cleanup path
          if (e?.code !== "EUNREADABLE") return json(res, 404, { error: "not found" });
        }
        // the run's git worktree lives INSIDE the run dir: unregister it from the
        // project repo first (a bare rm would leave a dangling worktree record)
        const wtOut = await pipeline.removeWorktree(id);
        discardRun(id); // drop any buffered writes so they can't resurrect the dir
        fs.rmSync(path.join(runsDir(), id), { recursive: true, force: true });
        return json(res, 200, { ok: true, ...(wtOut?.keptBranch ? { keptBranch: wtOut.keptBranch, reason: wtOut.reason } : {}) });
      }
      if (req.method === "POST" && action === "gate") {
        const body = expect(await readBody(req), { action: "string?", comments: "string?" });
        const ok = pipeline.gate(id, body.action === "cancel" ? "cancel" : body.action === "reject" ? "reject" : "approve", body.comments);
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "answers") {
        const body = expect(await readBody(req), { answers: "object?" });
        const ok = pipeline.answer(id, body.answers ?? {});
        return json(res, ok ? 200 : 409, { ok });
      }
      if (req.method === "POST" && action === "model") {
        const body = expect(await readBody(req), { step: "string?", node: "string?", model: "string?" });
        const out = pipeline.setStepModel(id, String(body.step ?? body.node ?? ""), String(body.model ?? "auto"));
        return json(res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && action === "cancel") {
        return json(res, 200, { ok: pipeline.cancel(id) });
      }
      if (req.method === "POST" && action === "resume") {
        const body = expect(await readBody(req), { fix: "boolean?" });
        const opts = { fix: body.fix === true };
        // Q-H4: a ticket's run resumes THROUGH the queue (keeps the ticket and
        // its settle callback in sync); null = not a ticket run → plain resume.
        let out = queueManager.resumeRun(id, opts);
        if (!out) {
          out = pipeline.resume(id, opts);
          if (!out.ok && /not active in this server session/.test(String(out.error ?? ""))) {
            // restart recovery: rebuild the controller from runs/<id>/state.json
            out = pipeline.resumeFromDisk(id, undefined, opts);
          }
        }
        return json(res, out.ok ? 200 : 409, out);
      }
    }

    // static GUI with SPA fallback (authenticated like everything else)
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 400, { error: "bad path" });
    }
    if (rel.includes("\0")) return json(res, 400, { error: "bad path" });
    let file = path.resolve(WEB_DIST, "." + (rel === "/" ? "/index.html" : rel));
    const outside = path.relative(WEB_DIST, file);
    if (outside.startsWith("..") || path.isAbsolute(outside)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(WEB_DIST, "index.html");
    }
    if (!fs.existsSync(file)) {
      return json(res, 503, { error: "GUI not built — run: npm run build" });
    }
    // HTML must revalidate (it references hashed assets by name); hashed
    // assets are immutable and cacheable forever (but only privately: the
    // GUI sits behind auth, so shared caches must not keep it).
    const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    headers["cache-control"] = file.endsWith(".html") ? "no-cache" : "private, max-age=31536000, immutable";
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader("connection", "close");
      return json(res, err.status, { error: err.message });
    }
    console.error("[http error]", req.method, url.pathname, err);
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

// WebSocket: same auth + Origin rules as HTTP, enforced at the upgrade so an
// unauthenticated or cross-origin page never gets a socket (and never sees events).
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
function rejectUpgrade(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
  if (!auth.hostOk(req)) return rejectUpgrade(socket, 421, "Misdirected Request");
  if (!auth.originOk(req)) return rejectUpgrade(socket, 403, "Forbidden");
  const verdict = auth.authenticate(req);
  if (verdict === "limited") return rejectUpgrade(socket, 429, "Too Many Requests");
  if (verdict !== "ok") return rejectUpgrade(socket, 401, "Unauthorized");
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
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
  c.on("error", () => wsClients.delete(c));
});

// Graceful stop: other modules also listen for these signals, so the default
// "die on SIGTERM" never fires — without this, `systemctl stop` hangs until SIGKILL.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[nano-cycle] ${sig} — flushing state and shutting down`);
    try {
      flushAll();
    } catch {
      /* best-effort */
    }
    for (const c of wsClients) {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
server.listen(PORT, HOST, () => {
  const port = server.address().port;
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  const base = PUBLIC_URL || `http://${shown}:${port}`;
  console.log(`[nano-cycle] listening on http://${HOST}:${port}`);
  if (tokenInfo.created) {
    // Printed exactly once: later boots reuse the stored token and never log it.
    console.log("[nano-cycle] ------------------------------------------------------------");
    console.log(`[nano-cycle] first boot - access token generated (saved 0600 at ${tokenInfo.file}):`);
    console.log(`[nano-cycle]   ${tokenInfo.token}`);
    console.log(`[nano-cycle] one-time login link: ${base}/login?token=${tokenInfo.token}`);
    console.log("[nano-cycle] ------------------------------------------------------------");
  } else if (tokenInfo.source === "env") {
    console.log(`[nano-cycle] auth: token from NANO_TOKEN - sign in at ${base}/login`);
  } else {
    console.log(`[nano-cycle] auth: token in ${tokenInfo.file} - sign in at ${base}/login`);
  }
  if (!isLoopback && !PUBLIC_URL.startsWith("https://")) {
    console.warn(
      `[nano-cycle] WARNING: bound to ${HOST} without a TLS hint - the token and session cookie would travel in cleartext. ` +
        "Terminate TLS in front (Tailscale serve / Caddy) and set NANO_PUBLIC_URL=https://..., or bind NANO_HOST=127.0.0.1.",
    );
  }
  console.log(`[nano-cycle] projects: ${loadProjects().map((p) => p.name).join(", ")}`);
});
