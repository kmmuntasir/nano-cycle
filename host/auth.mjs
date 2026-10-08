// Server auth — one shared bearer token guards every /api route, the WebSocket
// and the GUI. Safe to expose behind Tailscale / a TLS reverse proxy.
//
// Token: NANO_TOKEN (min 24 chars) or a random 32-byte value generated at first
// boot and persisted 0600 (NANO_TOKEN_FILE, default <repo>/.nano-token — gitignored).
// Presented as `Authorization: Bearer <token>` (scripts, MCP) or as the
// `nano_session` cookie (browsers; set by /login or a one-time ?token= link).
//
// Dependency-free on purpose (node builtins only): host/mcp-tickets.mjs reuses
// readTokenFile() without pulling in the server.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const COOKIE_NAME = "nano_session";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const MIN_TOKEN_LEN = 24;

/** Where the generated token is persisted. */
export function tokenFilePath() {
  return process.env.NANO_TOKEN_FILE ? path.resolve(process.env.NANO_TOKEN_FILE) : path.join(ROOT, ".nano-token");
}

/** The persisted token, or null when none exists yet. */
export function readTokenFile(file = tokenFilePath()) {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    return t.length >= MIN_TOKEN_LEN ? t : null;
  } catch {
    return null;
  }
}

/** Resolve the server token: env wins, then the token file, else generate one.
 *  `created` is true only when this call minted a new token (print it once). */
export function loadOrCreateToken({ file = tokenFilePath(), envToken = process.env.NANO_TOKEN } = {}) {
  const fromEnv = String(envToken ?? "").trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_TOKEN_LEN) throw new Error(`NANO_TOKEN must be at least ${MIN_TOKEN_LEN} characters`);
    return { token: fromEnv, created: false, source: "env", file: null };
  }
  const existing = readTokenFile(file);
  if (existing) {
    try {
      if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600); // tighten a file someone loosened
    } catch { /* best-effort */ }
    return { token: existing, created: false, source: "file", file };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600 from creation (no chmod-after-write window); replace a short/corrupt file.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
  return { token, created: true, source: "file", file };
}

/** Constant-time string compare. Digesting first hides the length too. */
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const normHost = (h) => String(h ?? "").trim().toLowerCase();
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function createAuth({
  token,
  allowedOrigins = csv(process.env.NANO_ALLOWED_ORIGINS),
  allowedHosts = csv(process.env.NANO_ALLOWED_HOSTS),
  trustProxy = process.env.NANO_TRUST_PROXY === "1",
  maxFailures = 10,
  windowMs = 10 * 60_000,
} = {}) {
  const origins = new Set(allowedOrigins.map((o) => { try { return new URL(o).origin; } catch { return o.replace(/\/$/, ""); } }));
  const hosts = new Set(allowedHosts.map(normHost));

  // --- failed-credential limiter (per client address) ---
  const fails = new Map(); // key -> { n, resetAt }
  function clientKey(req) {
    if (trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]; // appended by OUR proxy; earlier hops are client-controlled
    }
    return req.socket?.remoteAddress ?? "unknown";
  }
  /** Seconds until this client may try again (0 = not limited). */
  function retryAfter(req) {
    const e = fails.get(clientKey(req));
    if (!e) return 0;
    if (Date.now() >= e.resetAt) { fails.delete(clientKey(req)); return 0; }
    return e.n >= maxFailures ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
  }
  function recordFailure(req) {
    const now = Date.now();
    if (fails.size > 2000) for (const [k, v] of fails) if (now >= v.resetAt) fails.delete(k);
    const key = clientKey(req);
    const e = fails.get(key);
    if (!e || now >= e.resetAt) fails.set(key, { n: 1, resetAt: now + windowMs });
    else e.n++;
  }
  const clearFailures = (req) => fails.delete(clientKey(req));

  /** Pull a presented credential out of a request. */
  function credential(req) {
    const authz = String(req.headers.authorization ?? "");
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (m) return { kind: "bearer", value: m[1].trim() };
    const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (c) return { kind: "cookie", value: c };
    return null;
  }

  /** "ok" | "none" (no credential) | "bad" (wrong credential) | "limited" (too many bad bearer/login attempts).
   *  Only bearer and login failures feed the limiter: a stale cookie after a token rotation
   *  must not lock the browser out of /login. */
  function authenticate(req) {
    const cred = credential(req);
    if (!cred) return "none";
    if (cred.kind === "bearer" && retryAfter(req)) return "limited";
    if (safeEqual(cred.value, token)) return "ok";
    if (cred.kind === "bearer") recordFailure(req);
    return "bad";
  }

  /** Check a token typed into /login or passed as ?token=. Counts failures. */
  function checkLogin(req, presented) {
    if (retryAfter(req)) return "limited";
    if (safeEqual(String(presented ?? "").trim(), token)) { clearFailures(req); return "ok"; }
    recordFailure(req);
    return "bad";
  }

  const isHttps = (req) => !!req.socket?.encrypted || /(^|,)\s*https\s*(,|$)/i.test(String(req.headers["x-forwarded-proto"] ?? ""));

  function sessionCookie(req) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${isHttps(req) ? "; Secure" : ""}`;
  }
  function clearCookie(req) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
  }

  /** Browser requests carry Origin on every cross-origin write and on WS
   *  upgrades. It must be this server (Origin host == Host) or allowlisted
   *  (NANO_ALLOWED_ORIGINS, for proxies that rewrite Host). No Origin means a
   *  non-browser client, which still needs the token. */
  function originOk(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    let u;
    try { u = new URL(origin); } catch { return false; }
    if (origins.has(u.origin)) return true;
    return !!req.headers.host && normHost(u.host) === normHost(req.headers.host);
  }

  /** Optional DNS-rebinding guard: when NANO_ALLOWED_HOSTS is set, the Host header must be listed. */
  function hostOk(req) {
    if (hosts.size === 0) return true;
    const h = normHost(req.headers.host);
    return hosts.has(h) || hosts.has(h.replace(/:\d+$/, ""));
  }

  return { authenticate, checkLogin, retryAfter, sessionCookie, clearCookie, originOk, hostOk, isHttps, credential };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Self-contained login page: no external assets, no JS (a plain form POST). */
export function loginPageHtml({ error = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>nano-cycle - sign in</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.4 system-ui,sans-serif;background:#0f1115;color:#e6e6e6}
@media (prefers-color-scheme:light){body{background:#f4f5f7;color:#1a1a1a}}
form{width:min(92vw,380px);padding:24px;border:1px solid #8884;border-radius:12px;display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 4px;font-size:20px}
p{margin:0;font-size:14px;opacity:.75}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit}
button{background:#3b82f6;border-color:#3b82f6;color:#fff;cursor:pointer}
.err{color:#ef4444;opacity:1}
</style></head><body>
<form method="post" action="/login">
<h1>nano-cycle</h1>
<p>Enter the access token printed at first boot (or the contents of the server's .nano-token file).</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<input type="password" name="token" placeholder="access token" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form></body></html>`;
}

/** A page (not a 302) that lands on "/" — the cookie was just set by a possibly
 *  cross-site navigation, and SameSite=Strict cookies are withheld from a
 *  redirect chain that started cross-site; a meta refresh is a fresh same-site hop. */
export function continuePageHtml(to = "/") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${esc(to)}"><title>nano-cycle</title></head>
<body><a href="${esc(to)}">Continue</a></body></html>`;
}
