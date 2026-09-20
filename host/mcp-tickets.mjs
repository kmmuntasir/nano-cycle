#!/usr/bin/env node
// nano-cycle MCP server — agent access to the ticket queue over stdio
// (JSON-RPC per the Model Context Protocol; zero dependencies).
//
// The pattern-matching backlog import can't cover every features-doc shape.
// This is the reliable alternative: the AGENT reads the project's own docs
// with its file tools, structures the tickets, and pushes them in — the
// parser is bypassed entirely. It also exposes the whole queue (clarify
// waves, release, parking, the PM Inbox) so an agent can drive delivery.
//
// Register (Claude Code):
//   claude mcp add nano-cycle -- node /path/to/nano-cycle/host/mcp-tickets.mjs
// Any MCP client:
//   command: node, args: [<repo>/host/mcp-tickets.mjs]
// Base URL: env NANO_CYCLE_URL (default http://127.0.0.1:4177) — the host
// server must be running.
import readline from "node:readline";

const BASE = (process.env.NANO_CYCLE_URL ?? "http://127.0.0.1:4177").replace(/\/$/, "");
const enc = encodeURIComponent;

async function api(method, apiPath, body) {
  let res;
  try {
    res = await fetch(BASE + apiPath, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`nano-cycle unreachable at ${BASE} (is the server running? npm start) — ${e?.message ?? e}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 2000);
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? data.error : `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

const S = {
  project: { type: "string", description: "nano-cycle project name (see nano_list_projects)" },
  runId: { type: "string", description: "run id (see nano_get_tickets / nano_inbox)" },
};

const TOOLS = [
  {
    name: "nano_list_projects",
    description: "List nano-cycle projects (name + path). Every other tool takes a project name from here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => api("GET", "/api/projects"),
  },
  {
    name: "nano_get_tickets",
    description:
      "Read a project's ticket store: every ticket (id, title, description, status, blockedReason, deps, runId) plus the queue state and run-config. Start here to see the backlog's shape.",
    inputSchema: { type: "object", properties: { project: S.project }, required: ["project"], additionalProperties: false },
    run: (a) => api("GET", `/api/tickets/${enc(a.project)}`),
  },
  {
    name: "nano_create_ticket",
    description:
      "Create one ticket. id optional (auto T01, T02…); dependsOn must reference existing ticket ids. Tickets start as draft — run a clarify wave (nano_queue action=clarify) to produce specs.",
    inputSchema: {
      type: "object",
      properties: {
        project: S.project,
        id: { type: "string", description: "Ticket id slug, e.g. F07 or GM-12 (optional)" },
        title: { type: "string" },
        description: { type: "string", description: "What done looks like — becomes the PM's brief and the requirements source" },
        dependsOn: { type: "array", items: { type: "string" } },
      },
      required: ["project", "title"],
      additionalProperties: false,
    },
    run: (a) => api("POST", `/api/tickets/${enc(a.project)}`, a),
  },
  {
    name: "nano_bulk_create_tickets",
    description:
      "THE import path for arbitrary formats: read the project's feature/PRD docs yourself, structure them, and push all tickets in one call. No pattern matching involved — you are the parser. Existing ids are skipped (idempotent); dependsOn may reference tickets later in the same batch; done:true imports as already done (with sourceDoc provenance for status flips).",
    inputSchema: {
      type: "object",
      properties: {
        project: S.project,
        sourceDoc: { type: "string", description: "Provenance for the backlog status flip, e.g. docs/features.md (optional)" },
        tickets: {
          type: "array",
          description: "Ordered tickets; later tickets may dependOn earlier ones",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
              done: { type: "boolean" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["project", "tickets"],
      additionalProperties: false,
    },
    run: (a) => api("POST", `/api/tickets/${enc(a.project)}/import`, { json: a.tickets, sourceDoc: a.sourceDoc }),
  },
  {
    name: "nano_import_features_file",
    description:
      'Import a features doc FROM the project by path (default docs/features.md) using the lenient parser: headings ("## F01 — Title 🔴") or checkbox lists ("- [x] **F01 — Title**" with "Builds on:" lines). For other shapes, structure the doc yourself and use nano_bulk_create_tickets.',
    inputSchema: {
      type: "object",
      properties: { project: S.project, path: { type: "string", default: "docs/features.md" } },
      required: ["project"],
      additionalProperties: false,
    },
    run: (a) => api("POST", `/api/tickets/${enc(a.project)}/import`, { path: a.path ?? "docs/features.md" }),
  },
  {
    name: "nano_update_ticket",
    description: "Edit a ticket (title, description, dependsOn — cycle-checked, order, sourceDoc).",
    inputSchema: {
      type: "object",
      properties: {
        project: S.project,
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" } },
        order: { type: "number" },
        sourceDoc: { type: "string" },
      },
      required: ["project", "id"],
      additionalProperties: false,
    },
    run: (a) => api("PATCH", `/api/tickets/${enc(a.project)}/${enc(a.id)}`, a),
  },
  {
    name: "nano_delete_ticket",
    description: "Delete a ticket (draft/blocked ones; it is also stripped from other tickets' dependsOn).",
    inputSchema: { type: "object", properties: { project: S.project, id: { type: "string" } }, required: ["project", "id"], additionalProperties: false },
    run: (a) => api("DELETE", `/api/tickets/${enc(a.project)}/${enc(a.id)}`),
  },
  {
    name: "nano_queue",
    description:
      "Drive the queue. Actions: clarify (ticketIds — parallel PM runs, answer via nano_inbox), release (ticketIds optional — sequential build/verify/security per ticket), pause, resume, retry (ticketId — resume a parked run), reclarify (ticketId — fresh PM run seeded with the old spec + blocker), reorder (orderedIds — full desired order), config (models/options — run defaults).",
    inputSchema: {
      type: "object",
      properties: {
        project: S.project,
        action: { type: "string", enum: ["clarify", "release", "pause", "resume", "retry", "reclarify", "reorder", "config"] },
        ticketIds: { type: "array", items: { type: "string" } },
        ticketId: { type: "string" },
        orderedIds: { type: "array", items: { type: "string" } },
        models: { type: "object", description: "{clarify,builder,verifier,security} model ids or \"auto\"" },
        options: { type: "object", description: "Run defaults: git, audit, security, maxFixRounds, remoteChecks (approvePlan is always false in queue mode)" },
      },
      required: ["project", "action"],
      additionalProperties: false,
    },
    run: (a) => api("POST", `/api/queue/${enc(a.project)}`, a),
  },
  {
    name: "nano_inbox",
    description: "The PM Inbox: every live question batch across the project's clarify runs, grouped by ticket. Empty until a wave's PMs ask.",
    inputSchema: { type: "object", properties: { project: S.project }, required: ["project"], additionalProperties: false },
    run: (a) => api("GET", `/api/inbox/${enc(a.project)}`),
  },
  {
    name: "nano_answer",
    description:
      "Answer one run's PM questions: a map of question id → answer text (ids from nano_inbox). Answering completes the round; the PM either asks more or locks the spec.",
    inputSchema: {
      type: "object",
      properties: { runId: S.runId, answers: { type: "object", additionalProperties: { type: "string" } } },
      required: ["runId", "answers"],
      additionalProperties: false,
    },
    run: (a) => api("POST", `/api/runs/${enc(a.runId)}/answers`, { answers: a.answers }),
  },
  {
    name: "nano_get_run",
    description: "Read a run: status, steps, the locked spec (artifacts.spec), gates, audit results — everything the Review tab shows. Use it to inspect specs before releasing a queue.",
    inputSchema: { type: "object", properties: { runId: S.runId }, required: ["runId"], additionalProperties: false },
    run: (a) => api("GET", `/api/runs/${enc(a.runId)}`),
  },
];

// --- minimal MCP stdio (newline-delimited JSON-RPC 2.0) ---------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "nano-cycle", version: "3.0.0" },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `unknown tool "${params?.name}"` }] } };
      }
      try {
        const out = await tool.run(params?.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] },
        };
      } catch (e) {
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] } };
      }
    }
    default:
      return undefined; // notifications (initialized/cancelled) and unknown methods: silence
  }
}

process.stderr.write(`[nano-cycle-mcp] serving ${BASE} (${TOOLS.length} tools)\n`);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // not JSON-RPC — ignore
  }
  handle(msg)
    .then((resp) => {
      if (resp) send(resp);
    })
    .catch((e) => {
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    });
});
