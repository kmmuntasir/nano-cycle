// MCP server smoke test — drives host/mcp-tickets.mjs over stdio (real child
// process, newline-delimited JSON-RPC) against a mock of the host REST API.
// Run: node tests/mcp.test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert";

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`);
  }
};

// --- mock host REST API -----------------------------------------------------------

const hits = [];
const store = { project: "demo", config: { models: {}, options: {} }, tickets: [], queue: { state: "idle", pausedAt: null } };
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    let body = null;
    try {
      body = data ? JSON.parse(data) : null;
    } catch {
      body = null;
    }
    hits.push({ method: req.method, path: req.url, body, auth: req.headers.authorization ?? null });
    const json = (b) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url.startsWith("/api/secure")) {
      if (req.headers.authorization !== "Bearer s3cret") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return json({ ok: true });
    }
    if (req.method === "GET" && req.url === "/api/projects") return json([{ name: "demo", path: "/tmp/demo" }]);
    if (req.method === "GET" && req.url === "/api/tickets/demo") return json(store);
    if (req.method === "POST" && req.url === "/api/tickets/demo") {
      const t = { id: "T01", status: "draft", ...body };
      store.tickets.push(t);
      return json(t);
    }
    if (req.method === "POST" && req.url === "/api/tickets/demo/import") {
      const created = (body.json ?? []).map((t) => t.id ?? "T");
      for (const t of body.json ?? []) store.tickets.push({ status: "draft", ...t });
      return json({ created, skipped: [] });
    }
    if (req.method === "POST" && req.url === "/api/queue/demo") return json({ ok: true, action: body.action });
    if (req.method === "GET" && req.url === "/api/inbox/demo") return json({ project: "demo", items: [] });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// --- stdio JSON-RPC driver ----------------------------------------------------------

function spawnMcp(extraEnv = {}) {
  const env = { ...process.env, NANO_CYCLE_URL: `http://127.0.0.1:${port}`, ...extraEnv };
  if (!("NANO_TOKEN" in extraEnv)) delete env.NANO_TOKEN;
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "host", "mcp-tickets.mjs")], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let nextId = 1;
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const key = msg.id === undefined ? null : msg.id;
      if (pending.has(key)) {
        pending.get(key)(msg);
        pending.delete(key);
      }
    }
  });
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 5000);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    // a raw line (malformed JSON etc.); replies with id null are keyed under null
    raw(line) {
      return new Promise((resolve, reject) => {
        pending.set(null, resolve);
        setTimeout(() => (pending.has(null) ? (pending.delete(null), reject(new Error("timeout waiting for raw reply"))) : 0), 5000);
        child.stdin.write(line + "\n");
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    close() {
      child.kill();
    },
  };
}

const mcp = spawnMcp();
const textOf = (resp) => resp?.result?.content?.[0]?.text ?? "";

await test("initialize → protocol version + tools capability", async () => {
  const r = await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.strictEqual(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.strictEqual(r.result.serverInfo.name, "nano-cycle");
  mcp.notify("notifications/initialized");
});

await test("tools/list → 11 tools with schemas, bulk-import present", async () => {
  const r = await mcp.call("tools/list", {});
  const names = r.result.tools.map((t) => t.name);
  assert.strictEqual(names.length, 11, JSON.stringify(names));
  for (const t of r.result.tools) assert.ok(t.inputSchema?.type === "object", `${t.name} has an input schema`);
  assert.ok(names.includes("nano_bulk_create_tickets"));
  assert.ok(names.includes("nano_inbox") && names.includes("nano_answer") && names.includes("nano_queue"));
});

await test("nano_list_projects → live data from the host API", async () => {
  const r = await mcp.call("tools/call", { name: "nano_list_projects", arguments: {} });
  assert.match(textOf(r), /demo/);
  assert.strictEqual(r.result.isError, undefined);
});

await test("nano_create_ticket → POSTs to the store, returns the ticket", async () => {
  const r = await mcp.call("tools/call", {
    name: "nano_create_ticket",
    arguments: { project: "demo", id: "F01", title: "First", description: "do the thing" },
  });
  assert.match(textOf(r), /"id": "F01"/);
  const hit = hits.find((h) => h.method === "POST" && h.path === "/api/tickets/demo");
  assert.ok(hit, "request reached the API");
  assert.strictEqual(hit.body.title, "First");
});

await test("nano_bulk_create_tickets → structured agent import (deps in one batch)", async () => {
  const r = await mcp.call("tools/call", {
    name: "nano_bulk_create_tickets",
    arguments: {
      project: "demo",
      sourceDoc: "docs/PRD.md",
      tickets: [
        { id: "P01", title: "Auth", description: "login" },
        { id: "P02", title: "Sessions", description: "persist", dependsOn: ["P01"] },
        { id: "P03", title: "Legacy", description: "old", done: true },
      ],
    },
  });
  const out = JSON.parse(textOf(r));
  assert.deepStrictEqual(out.created, ["P01", "P02", "P03"]);
  const hit = hits.find((h) => h.path === "/api/tickets/demo/import");
  assert.strictEqual(hit.body.json.length, 3, "tickets travel as the json array — no markdown parsing involved");
  assert.strictEqual(hit.body.sourceDoc, "docs/PRD.md");
});

await test("nano_queue clarify + nano_inbox → queue actions route through", async () => {
  const q = await mcp.call("tools/call", { name: "nano_queue", arguments: { project: "demo", action: "clarify", ticketIds: ["F01"] } });
  assert.match(textOf(q), /"ok": true/);
  const inbox = await mcp.call("tools/call", { name: "nano_inbox", arguments: { project: "demo" } });
  assert.match(textOf(inbox), /"items": \[\]/);
});

await test("unknown tool → JSON-RPC -32602 (protocol error), not a crash", async () => {
  const r = await mcp.call("tools/call", { name: "nano_nope", arguments: {} });
  assert.strictEqual(r.error?.code, -32602);
  assert.match(r.error.message, /unknown tool/);
});

await test("missing required argument → -32602, no host call made", async () => {
  const before = hits.length;
  const r = await mcp.call("tools/call", { name: "nano_get_tickets", arguments: {} });
  assert.strictEqual(r.error?.code, -32602);
  assert.match(r.error.message, /project/);
  assert.strictEqual(hits.length, before);
});

await test("unknown method with an id → -32601; notifications get no reply", async () => {
  const r = await mcp.call("resources/list", {});
  assert.strictEqual(r.error?.code, -32601);
  mcp.notify("notifications/cancelled", { requestId: 1 }); // must not produce a reply
  const ping = await mcp.call("ping", {});
  assert.deepStrictEqual(ping.result, {});
});

await test("malformed JSON → -32700 with id null; stays alive", async () => {
  const r = await mcp.raw("{not json");
  assert.strictEqual(r.error?.code, -32700);
  assert.strictEqual(r.id, null);
  const ping = await mcp.call("ping", {});
  assert.deepStrictEqual(ping.result, {});
});

await test("NANO_TOKEN → Authorization: Bearer header on every host call; absent → none", async () => {
  hits.length = 0;
  await mcp.call("tools/call", { name: "nano_list_projects", arguments: {} });
  assert.strictEqual(hits.at(-1).auth, null, "no token configured → no header");
  const authed = spawnMcp({ NANO_TOKEN: "s3cret" });
  try {
    await authed.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    await authed.call("tools/call", { name: "nano_list_projects", arguments: {} });
    assert.strictEqual(hits.at(-1).auth, "Bearer s3cret");
  } finally {
    authed.close();
  }
});

await test("a 401 from the host becomes an actionable isError result", async () => {
  // the mock gates /api/secure*; a base URL ending in it routes every tool call there
  const bad = spawnMcp({ NANO_TOKEN: "wrong", NANO_CYCLE_URL: `http://127.0.0.1:${port}/api/secure?x=` });
  try {
    await bad.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const r = await bad.call("tools/call", { name: "nano_list_projects", arguments: {} });
    assert.strictEqual(r.result.isError, true);
    assert.match(textOf(r), /NANO_TOKEN|HTTP 401/);
  } finally {
    bad.close();
  }
});

await test("API error surfaces as an isError tool result", async () => {
  const r = await mcp.call("tools/call", { name: "nano_get_run", arguments: { runId: "missing" } });
  assert.strictEqual(r.result.isError, true);
  assert.match(textOf(r), /not found|404|HTTP/);
});

mcp.close();
server.close();

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} MCP tests passed`);
process.exit(failed ? 1 : 0);
