// Server auth / CSRF / registry-only project tests. Run: node tests/auth.test.mjs
// Spawns its OWN server on a random free port with throwaway runs/tickets/
// projects/token files — never touches the live server or live data.
import "./_test-dirs.mjs"; // sets NANO_RUNS_DIR / NANO_TICKETS_DIR to temp dirs (inherited by the child)
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createAuth, loadOrCreateToken, safeEqual } from "../host/auth.mjs";

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split("\n").slice(0, 3).join("\n      ")}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nano-auth-test-"));
const projDir = path.join(tmp, "proj1");
fs.mkdirSync(projDir);
const projectsFile = path.join(tmp, "projects.json");
fs.writeFileSync(projectsFile, JSON.stringify({ projects: [{ name: "proj1", path: projDir }] }));
const tokenFile = path.join(tmp, "nano-token");

// --- unit: token store + helpers (no server) ---------------------------------------
await test("token: generated 0600, reused (never re-announced), env too short rejected", () => {
  const f = path.join(tmp, "unit-token");
  const a = loadOrCreateToken({ file: f, envToken: "" });
  assert.equal(a.created, true);
  assert.ok(a.token.length >= 32);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const b = loadOrCreateToken({ file: f, envToken: "" });
  assert.equal(b.created, false);
  assert.equal(b.token, a.token);
  assert.throws(() => loadOrCreateToken({ file: f, envToken: "short" }), /at least/);
  assert.equal(loadOrCreateToken({ file: f, envToken: "x".repeat(30) }).source, "env");
});

await test("safeEqual: equal / unequal / different lengths", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

await test("originOk: same host, allowlist, foreign, null", () => {
  const a = createAuth({ token: "t".repeat(32), allowedOrigins: ["https://nano.example.ts.net"] });
  const mk = (origin, host = "10.0.0.5:4177") => ({ headers: { ...(origin !== undefined ? { origin } : {}), host } });
  assert.equal(a.originOk(mk(undefined)), true);
  assert.equal(a.originOk(mk("http://10.0.0.5:4177")), true);
  assert.equal(a.originOk(mk("https://nano.example.ts.net")), true);
  assert.equal(a.originOk(mk("https://evil.example")), false);
  assert.equal(a.originOk(mk("null")), false);
});

// --- spawn a real server ------------------------------------------------------------
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
let out = "";
const child = spawn(process.execPath, ["host/server.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    NANO_PORT: String(port),
    NANO_HOST: "127.0.0.1",
    NANO_PROJECTS_FILE: projectsFile,
    NANO_TOKEN_FILE: tokenFile,
    NANO_TOKEN: "",
    NANO_MAX_BODY_BYTES: "2048",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const stop = () => {
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
};
process.on("exit", () => {
  stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method, p, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const h = { ...headers };
    if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
    if (payload !== undefined) h["content-length"] = Buffer.byteLength(payload);
    const r = http.request(base + p, { method, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(data); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json: j });
      });
    });
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// Wait for the server to come up.
{
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    if (child.exitCode !== null) break;
    try { up = (await request("GET", "/api/health")).status === 200; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) {
    console.log(out);
    console.log("FAIL  server did not start");
    stop();
    process.exit(1);
  }
}
const token = fs.readFileSync(tokenFile, "utf8").trim();
const bearer = { authorization: `Bearer ${token}` };

await test("first boot: token persisted 0600 and printed once with a login link", () => {
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.ok(out.includes(token), "token printed on first boot");
  assert.ok(out.includes(`/login?token=${token}`));
});

await test("health is unauthenticated and carries no data", async () => {
  const r = await request("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

await test("401 JSON without a token on /api; HTML routes redirect to /login", async () => {
  const api = await request("GET", "/api/projects");
  assert.equal(api.status, 401);
  assert.equal(api.json.error, "unauthorized");
  const root = await request("GET", "/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/login");
  const login = await request("GET", "/login");
  assert.equal(login.status, 200);
  assert.ok(/<form[^>]*action="\/login"/.test(login.text));
  assert.ok(!/https?:\/\//.test(login.text.replace(/<!doctype[^>]*>/i, "")), "login page loads no external assets");
});

await test("wrong bearer token is rejected", async () => {
  const r = await request("GET", "/api/projects", { headers: { authorization: "Bearer nope" } });
  assert.equal(r.status, 401);
});

await test("bearer token authenticates", async () => {
  const r = await request("GET", "/api/projects", { headers: bearer });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((p) => p.name), ["proj1"]);
});

let cookie = "";
await test("cookie login: bad token 401, good token 303 + HttpOnly SameSite=Strict cookie that works", async () => {
  const bad = await request("POST", "/login", { headers: { "content-type": "application/x-www-form-urlencoded" }, raw: "token=wrong" });
  assert.equal(bad.status, 401);
  const good = await request("POST", "/login", { headers: { "content-type": "application/x-www-form-urlencoded" }, raw: `token=${encodeURIComponent(token)}` });
  assert.equal(good.status, 303);
  const sc = good.headers["set-cookie"][0];
  assert.match(sc, /^nano_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.doesNotMatch(sc, /Secure/);
  cookie = sc.split(";")[0];
  const api = await request("GET", "/api/projects", { headers: { cookie } });
  assert.equal(api.status, 200);
  const page = await request("GET", "/", { headers: { cookie } });
  assert.equal(page.status, 200, "GUI served once authenticated");
});

await test("Secure cookie when X-Forwarded-Proto=https; JSON login works", async () => {
  const r = await request("POST", "/login", { headers: { "x-forwarded-proto": "https" }, body: { token } });
  assert.equal(r.status, 200);
  assert.match(r.headers["set-cookie"][0], /; Secure/);
});

await test("one-time /?token= link sets the cookie; a wrong one does not", async () => {
  const ok = await request("GET", `/?token=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers["set-cookie"][0], /^nano_session=/);
  assert.match(ok.text, /http-equiv="refresh"/);
  const bad = await request("GET", "/?token=wrong");
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);
});

function wsOpen(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => { ws.close(); resolve({ open: true }); });
    ws.on("unexpected-response", (_req, res) => { resolve({ open: false, status: res.statusCode }); res.resume(); });
    ws.on("error", () => resolve({ open: false, status: 0 }));
  });
}

await test("WebSocket upgrade: rejected without credentials / bad origin, accepted with cookie or bearer", async () => {
  assert.deepEqual(await wsOpen({}), { open: false, status: 401 });
  assert.deepEqual(await wsOpen({ cookie, origin: "http://evil.example" }), { open: false, status: 403 });
  assert.equal((await wsOpen({ cookie, origin: `http://127.0.0.1:${port}` })).open, true);
  assert.equal((await wsOpen(bearer)).open, true);
});

await test("cross-origin state-changing request is rejected (even with a valid token)", async () => {
  const r = await request("POST", "/api/projects", { headers: { ...bearer, origin: "http://evil.example" }, body: { name: "x", path: projDir } });
  assert.equal(r.status, 403);
});

await test("non-JSON content types are rejected on body routes (text/plain CSRF vector)", async () => {
  const r = await request("POST", "/api/projects", { headers: { ...bearer, "content-type": "text/plain" }, raw: JSON.stringify({ name: "x", path: projDir }) });
  assert.equal(r.status, 415);
  const none = await request("POST", "/api/runs", { headers: bearer, raw: JSON.stringify({ task: "t" }) });
  assert.equal(none.status, 415);
});

await test("oversized body gets 413; malformed JSON and non-object bodies get 400", async () => {
  const big = await request("POST", "/api/projects", { headers: bearer, body: { name: "x", path: "y".repeat(5000) } });
  assert.equal(big.status, 413);
  const bad = await request("POST", "/api/projects", { headers: { ...bearer, "content-type": "application/json" }, raw: "{nope" });
  assert.equal(bad.status, 400);
  const arr = await request("POST", "/api/projects", { headers: bearer, body: [1] });
  assert.equal(arr.status, 400);
});

await test("body schema is validated (missing/mistyped fields -> 400)", async () => {
  const r = await request("POST", "/api/runs", { headers: bearer, body: { project: "proj1" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /task/);
  const r2 = await request("POST", "/api/runs", { headers: bearer, body: { task: "t", models: "auto" } });
  assert.equal(r2.status, 400);
});

await test("POST /api/runs accepts registered projects only (no absolute paths, no traversal)", async () => {
  for (const project of [projDir, "/", "/tmp", "../proj1", "nope"]) {
    const r = await request("POST", "/api/runs", { headers: bearer, body: { task: "do it", project } });
    assert.equal(r.status, 400, `${project} -> ${r.status}`);
    assert.ok(!fs.existsSync(path.join(process.env.NANO_RUNS_DIR, "x")), "no run dir created");
  }
  assert.equal(fs.readdirSync(process.env.NANO_RUNS_DIR).length, 0, "nothing started");
});

await test("queue/tickets reject unregistered project names, chat will not invent sessions", async () => {
  const q = await request("POST", "/api/queue/nope", { headers: bearer, body: { action: "pause" } });
  assert.equal(q.status, 400);
  const t = await request("POST", "/api/tickets/nope", { headers: bearer, body: { title: "x" } });
  assert.equal(t.status, 400);
  const abs = await request("GET", `/api/chat/${encodeURIComponent(projDir)}/sessions`, { headers: bearer });
  assert.equal(abs.status, 400, "absolute path is not a project name");
  const msg = await request("POST", "/api/chat/proj1/sessions/does-not-exist/message", { headers: bearer, body: { prompt: "run rm -rf" } });
  assert.equal(msg.status, 404, "unknown session id must error, not auto-create");
  const empty = await request("POST", "/api/chat/proj1/sessions/does-not-exist/message", { headers: bearer, body: { prompt: "  " } });
  assert.equal(empty.status, 400);
  const registered = await request("POST", "/api/queue/proj1", { headers: bearer, body: { action: "pause" } });
  assert.notEqual(registered.status, 400);
});

await test("static path traversal is contained", async () => {
  for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/assets/..%2f..%2f..%2fpackage.json"]) {
    const r = await request("GET", p, { headers: bearer });
    assert.ok(!r.text.includes('"nano-cycle"'), `${p} leaked package.json`);
  }
});

await test("repeated bad bearer tokens are rate limited (429)", async () => {
  let last = 0;
  for (let i = 0; i < 14; i++) last = (await request("GET", "/api/projects", { headers: { authorization: `Bearer wrong-${i}` } })).status;
  assert.equal(last, 429);
  const login = await request("POST", "/login", { body: { token: "wrong" } });
  assert.equal(login.status, 429);
});

stop();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} auth tests passed\n`);
if (passed !== results.length) {
  console.log("--- server output ---\n" + out.split("\n").slice(-30).join("\n"));
  process.exit(1);
}
process.exit(0);
