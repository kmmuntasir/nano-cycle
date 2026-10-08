// Mechanical-check fixture tests. Run: node tests/checks.test.mjs
// Every repo is generated into os.tmpdir() here — no committed fixture trees.
// Per check: a passing repo, a failing repo (the real defect is still caught),
// and the known false-positive shapes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { runMechanicalChecks, checkLevel, CHECK_DEFS } from "../host/checks.mjs";

delete process.env.NANO_CHECKS;
delete process.env.NANO_CHECKS_ADVISORY;
delete process.env.NANO_CHECK_TIMEOUT_MS;

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n      ")}`); }
};

const roots = [];
/** Create a repo from { "rel/path": string | object(JSON) }. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nano-checks-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}
process.on("exit", () => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** Run one check against a repo. */
async function run(id, files, opts = {}) {
  const projectPath = typeof files === "string" ? files : repo(files);
  const [r] = await runMechanicalChecks({ projectPath, only: [id], ...opts });
  assert.equal(r.id, id);
  return r;
}
const status = async (id, files, opts) => (await run(id, files, opts)).status;
const has = (r, re) => assert.match(r.evidence, re, `evidence: ${r.evidence}`);

// ---------------------------------------------------------------- shape ---

await test("result shape + all eight checks run + never throws on an empty/missing dir", async () => {
  const all = await runMechanicalChecks({ projectPath: repo({ "a.txt": "x" }), exec: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
  assert.deepEqual(all.map((c) => c.id).sort(), CHECK_DEFS.map((d) => d.id).sort());
  for (const c of all) {
    assert.ok(["pass", "warn", "fail", "skipped"].includes(c.status), c.id);
    assert.ok(["gating", "advisory"].includes(c.level), c.id);
    assert.equal(typeof c.evidence, "string");
    assert.ok(Array.isArray(c.findings));
    assert.equal(typeof c.title, "string");
  }
  const missing = await runMechanicalChecks({ projectPath: path.join(os.tmpdir(), "nano-checks-does-not-exist"), exec: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  assert.equal(missing.length, CHECK_DEFS.length);
  assert.ok(missing.every((c) => c.status !== "fail"));
});

// ---------------------------------------------------- secrets-gitleaks ---

const noTool = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };

await test("secrets: clean report passes", async () => {
  const r = await run("secrets-gitleaks", { "a.js": "x" }, { exec: async () => ({ stdout: "[]" }) });
  assert.equal(r.status, "pass");
});
await test("secrets: gitleaks exit 1 with findings fails and names file:line, not the secret", async () => {
  const report = JSON.stringify([{ File: "src/k.js", StartLine: 7, RuleID: "aws-key", Secret: "AKIA-SUPERSECRET" }]);
  const r = await run("secrets-gitleaks", { "a.js": "x" }, { exec: async () => { throw Object.assign(new Error("exit 1"), { code: 1, stdout: report }); } });
  assert.equal(r.status, "fail");
  has(r, /src\/k\.js:7 \(aws-key\)/);
  assert.ok(!JSON.stringify(r).includes("SUPERSECRET"));
  assert.equal(r.findings[0].file, "src/k.js");
});
await test("secrets: exit 1 with an unparseable report still fails (exit code is truth)", async () => {
  const r = await run("secrets-gitleaks", { "a.js": "x" }, { exec: async () => { throw Object.assign(new Error("exit 1"), { code: 1, stdout: "not json" }); } });
  assert.equal(r.status, "fail");
});
await test("secrets: falls back to docker, then skips when neither tool exists (skip never gates)", async () => {
  const calls = [];
  const viaDocker = await run("secrets-gitleaks", { "a.js": "x" }, { exec: async (cmd) => { calls.push(cmd); if (cmd === "gitleaks") throw Object.assign(new Error("x"), { code: "ENOENT" }); return { stdout: "[]" }; } });
  assert.deepEqual(calls, ["gitleaks", "docker"]);
  assert.equal(viaDocker.status, "pass");
  assert.equal(await status("secrets-gitleaks", { "a.js": "x" }, { exec: noTool }), "skipped");
});

// -------------------------------------------------------- deps-declared ---

await test("deps: declared imports pass; node builtins + relative + tsconfig alias ignored", async () => {
  const r = await run("deps-declared", {
    "package.json": { dependencies: { express: "1" }, devDependencies: { vitest: "1" } },
    "tsconfig.json": { compilerOptions: { paths: { "@app/*": ["src/*"] } } },
    "src/a.js": 'import express from "express";\nimport fs from "node:fs";\nimport path from "path";\nimport x from "./b.js";\nimport y from "@app/util";\n',
    "src/b.js": 'export const b = 1;\n',
    "vite.config.js": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ ignores: ["dist", "coverage"] });\n',
  });
  assert.equal(r.status, "pass", r.evidence);
});
await test("deps: undeclared import fails with file:line", async () => {
  const r = await run("deps-declared", { "package.json": { dependencies: {} }, "src/a.js": 'const x = require("left-pad");\n' });
  assert.equal(r.status, "fail");
  has(r, /left-pad \(src\/a\.js:1\)/);
  assert.equal(r.findings[0].file, "src/a.js");
});
await test("deps: monorepo — a sub-package's deps are not charged to the root manifest, but its own gaps are caught", async () => {
  const files = {
    "package.json": { name: "root" },
    "packages/web/package.json": { dependencies: { react: "1" } },
    "packages/web/src/a.js": 'import React from "react";\n',
  };
  assert.equal(await status("deps-declared", files), "pass");
  const bad = await run("deps-declared", { ...files, "packages/web/src/b.js": 'import z from "zod";\n' });
  assert.equal(bad.status, "fail");
  has(bad, /packages\/web\/package\.json — imported but undeclared: zod/);
});
await test("deps: config `plugins:` entries count, `ignores:` globs do not; no manifest = skipped", async () => {
  const bad = await run("deps-declared", { "package.json": {}, ".eslintrc.cjs": 'module.exports = { plugins: ["some-plugin"] };\n' });
  assert.equal(bad.status, "fail");
  has(bad, /some-plugin/);
  assert.equal(await status("deps-declared", { "a.js": "x" }), "skipped");
});

// ---------------------------------------------------------- no-cdn-fonts ---

await test("fonts: clean source passes", async () => {
  assert.equal(await status("no-cdn-fonts", { "index.html": "<link href='/fonts/inter.css'>", "a.css": "@font-face{src:url(/f.woff2)}" }), "pass");
});
await test("fonts: CDN reference in app code fails; under docs/ is only a warning", async () => {
  const bad = await run("no-cdn-fonts", { "src/a.css": "@import url(https://fonts.googleapis.com/css2?family=Inter);" });
  assert.equal(bad.status, "fail");
  assert.equal(bad.findings[0].line, 1);
  const docs = await run("no-cdn-fonts", { "docs/design/demo.html": "<link href='https://fonts.gstatic.com/x'>", "src/a.js": "x" });
  assert.equal(docs.status, "warn");
  const mixed = await run("no-cdn-fonts", { "docs/d.html": "fonts.gstatic.com", "src/a.html": "fonts.googleapis.com" });
  assert.equal(mixed.status, "fail");
});
await test("fonts: excluded toolchain/dependency dirs are not scanned", async () => {
  assert.equal(await status("no-cdn-fonts", { "node_modules/x/a.css": "fonts.googleapis.com", ".claude/skills/a.html": "fonts.gstatic.com", "src/a.js": "x" }), "pass");
});

// ----------------------------------------------------------- i18n-parity ---

await test("i18n: matching locale files pass", async () => {
  const r = await run("i18n-parity", { "src/locales/en.json": { a: "1", b: { c: "2" } }, "src/locales/bn.json": { a: "১", b: { c: "২" } } });
  assert.equal(r.status, "pass", r.evidence);
});
await test("i18n: a missing key in either direction fails", async () => {
  const r = await run("i18n-parity", { "i18n/en.json": { a: 1, b: 2 }, "i18n/fr.json": { a: 1, extra: 3 } });
  assert.equal(r.status, "fail");
  has(r, /missing in en — extra/);
  has(r, /missing in fr — b/);
});
await test("i18n: en-US/en-GB variants are separate members (no collision on 'en')", async () => {
  const r = await run("i18n-parity", { "locales/en-US.json": { a: 1 }, "locales/en-GB.json": { a: 1, b: 2 } });
  assert.equal(r.status, "fail");
  has(r, /missing in en-US — b/);
});
await test("i18n FP: two-letter .json files outside a locale directory are not a locale set", async () => {
  const r = await run("i18n-parity", { "data/db.json": { rows: [] }, "data/ui.json": { theme: "x" }, "config/ab.json": { x: 1 }, "config/cd.json": { y: 1 } });
  assert.equal(r.status, "skipped");
});
await test("i18n FP: package.json-like and non-ISO-named files in a locale dir are ignored", async () => {
  const r = await run("i18n-parity", {
    "locales/en.json": { a: 1 }, "locales/de.json": { a: 1 },
    "locales/package.json": { name: "x" }, "locales/index.json": { zzz: 1 }, "locales/tsconfig.json": {},
  });
  assert.equal(r.status, "pass", r.evidence);
});
await test("i18n: a single locale file is skipped, unparsable file ignored", async () => {
  assert.equal(await status("i18n-parity", { "locales/en.json": { a: 1 } }), "skipped");
  assert.equal(await status("i18n-parity", { "locales/en.json": { a: 1 }, "locales/fr.json": "{ not json" }), "skipped");
});

// ----------------------------------------------------------- env-wiring ---

await test("env: declared ↔ read reconciles (dotted, VITE_ prefix normalisation)", async () => {
  const r = await run("env-wiring", { ".env.example": "DB_URL=\n# NOTE=x\nVITE_API=\n", "src/a.js": "const u = process.env.DB_URL; const a = import.meta.env.VITE_API;\n" });
  assert.equal(r.status, "pass", r.evidence);
});
await test("env: read-but-undeclared and declared-but-unread both still fail", async () => {
  const r = await run("env-wiring", { ".env.example": "DB_URL=\nUNUSED_KEY=\n", "src/a.js": "process.env.DB_URL; process.env.SECRET_TOKEN;\n" });
  assert.equal(r.status, "fail");
  has(r, /read but not in any \.env\.example: SECRET_TOKEN \(src\/a\.js:1\)/);
  has(r, /declared but never read: UNUSED_KEY/);
  assert.equal(await status("env-wiring", { "a.js": "x" }), "skipped");
});
await test("env FP: destructuring (single + multi-line, renames, defaults) counts as reads", async () => {
  const r = await run("env-wiring", {
    ".env.example": "A=\nB=\nC=\nD=\n",
    "src/a.js": "const { A, B: renamed, C = 'x' } = process.env;\nconst {\n  D, // trailing comment\n} = process.env;\n",
  });
  assert.equal(r.status, "pass", r.evidence);
});
await test("env FP: bracket literal reads; dynamic env[k] is resolved via string literals, but unreferenced keys still fail", async () => {
  const ok = await run("env-wiring", {
    ".env.example": "ALPHA=\nBRAVO=\n",
    "src/a.js": "const a = process.env['ALPHA'];\nfunction need(k){ return process.env[k]; }\nneed(\"BRAVO\");\n",
  });
  assert.equal(ok.status, "pass", ok.evidence);
  const bad = await run("env-wiring", { ".env.example": "ALPHA=\nGHOST=\n", "src/a.js": "const k='ALPHA'; process.env[k];\nconst o = {...process.env};\n" });
  assert.equal(bad.status, "fail");
  has(bad, /declared but never read: GHOST/); // ALPHA is named in a string literal where env[k] is used; GHOST is not
});
await test("env FP: compose environment:/interpolation and env_file count as consumption", async () => {
  const viaCompose = await run("env-wiring", {
    ".env.example": "POSTGRES_PASSWORD=\nAPP_PORT=\n",
    "docker-compose.yml": "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n    ports:\n      - \"${APP_PORT}:80\"\n",
  });
  assert.equal(viaCompose.status, "pass", viaCompose.evidence);
  const viaFile = await run("env-wiring", { ".env.example": "ANYTHING=\nELSE=\n", "compose.yaml": "services:\n  app:\n    env_file:\n      - .env\n" });
  assert.equal(viaFile.status, "pass", viaFile.evidence);
});
await test("env FP: non-JS consumers (python) count; ambient vars (NODE_ENV, import.meta MODE/DEV) need no template entry", async () => {
  const r = await run("env-wiring", {
    ".env.example": "DATABASE_URL=\n",
    "api/main.py": "import os\nDB = os.environ['DATABASE_URL']\n",
    "src/a.js": "if (process.env.NODE_ENV === 'production' && import.meta.env.DEV && process.env.CI) {}\n",
  });
  assert.equal(r.status, "pass", r.evidence);
  // ...but a real app var that merely shares no ambient name is still caught
  const bad = await run("env-wiring", { ".env.example": "DATABASE_URL=\n", "api/main.py": "os.environ['DATABASE_URL']", "src/a.js": "process.env.STRIPE_KEY; import.meta.env.MODE;\n" });
  assert.equal(bad.status, "fail");
  has(bad, /STRIPE_KEY/);
  assert.ok(!/MODE/.test(bad.evidence));
});

// ------------------------------------------------------- readme-commands ---

const rootPkg = (scripts, extra = {}) => ({ name: "root", scripts, ...extra });

await test("readme: documented scripts resolve", async () => {
  const r = await run("readme-commands", {
    "package.json": rootPkg({ build: "x", "test:unit": "x" }),
    "README.md": "Run `npm run build` then `npm run test:unit`.\nSee ./scripts/setup.sh.\nnpx tsc --noEmit\n",
    "scripts/setup.sh": "#!/bin/sh\n",
  });
  assert.equal(r.status, "pass", r.evidence);
  has(r, /1 npx mention/);
});
await test("readme: missing script / missing ./scripts file / unknown workspace still fail", async () => {
  const r = await run("readme-commands", {
    "package.json": rootPkg({ build: "x" }),
    "README.md": "npm run deploy\n./scripts/gone.sh\nnpm run build -w packages/ghost\n",
  });
  assert.equal(r.status, "fail");
  has(r, /README:1 — "npm run deploy" has no such script in root package\.json/);
  has(r, /README:2 — "\.\/scripts\/gone\.sh" does not exist/);
  has(r, /README:3 — "npm run build" targets unknown workspace packages\/ghost/);
  assert.equal(r.findings[0].file, "README.md");
});
await test("readme FP: -w packages/x, --workspace=packages/x, --workspace x, by package name", async () => {
  const files = {
    "package.json": rootPkg({ lint: "x" }, { workspaces: ["packages/*"] }),
    "packages/x/package.json": { name: "@acme/x", scripts: { build: "x" } },
    "README.md": [
      "npm run build -w packages/x",
      "npm run build --workspace=packages/x",
      "npm run build --workspace packages/x",
      "npm -w packages/x run build",
      "npm run build -w @acme/x",
      "npm run build --workspaces",
      "npm run build --workspaces --if-present",
    ].join("\n"),
  };
  const r = await run("readme-commands", files);
  assert.equal(r.status, "pass", r.evidence);
  // ...and a script that is missing in that workspace is still reported against the workspace, not root
  const bad = await run("readme-commands", { ...files, "README.md": "npm run lint -w packages/x\nnpm run nothing --workspaces\n" });
  assert.equal(bad.status, "fail");
  has(bad, /"npm run lint" has no such script in packages\/x\/package\.json/);
  has(bad, /"npm run nothing --workspaces" matches no workspace/);
});
await test("readme FP: --prefix / -C / cd web && npm run ... resolve against that directory", async () => {
  const files = {
    "package.json": rootPkg({ start: "x" }),
    "web/package.json": { scripts: { dev: "x" } },
    "README.md": [
      "npm run dev --prefix web",
      "npm --prefix=web run dev",
      "npm run dev -C web",
      "`cd web && npm run dev`",
      "```bash",
      "git clone https://x/y.git",
      "cd y",
      "npm run whatever",
      "```",
      "```bash",
      "cd web",
      "npm run dev",
      "```",
      "npm run start",
    ].join("\n"),
  };
  const r = await run("readme-commands", files);
  assert.equal(r.status, "pass", r.evidence);
  const bad = await run("readme-commands", { ...files, "README.md": "npm run nope --prefix web\ncd web && npm run start\n" });
  assert.equal(bad.status, "fail");
  has(bad, /"npm run nope" has no such script in web\/package\.json/);
  has(bad, /"npm run start" has no such script in web\/package\.json/);
});
await test("readme FP: prose punctuation after a script/path; ../scripts is not ./scripts; <placeholder> ignored", async () => {
  const r = await run("readme-commands", {
    "package.json": rootPkg({ build: "x" }),
    "README.md": "Use npm run build. Then ./scripts/go.sh, or see ../scripts/elsewhere.sh and npm run <name>.\n",
    "scripts/go.sh": "x",
  });
  assert.equal(r.status, "pass", r.evidence);
});
await test("readme: no README or no root package.json = skipped", async () => {
  assert.equal(await status("readme-commands", { "package.json": {} }), "skipped");
  assert.equal(await status("readme-commands", { "README.md": "npm run x" }), "skipped");
});

// ----------------------------------------------------------- compose-env ---

await test("compose-env: no .env passes; .env + compose warns; .env without compose passes", async () => {
  assert.equal(await status("compose-env", { "docker-compose.yml": "services: {}\n" }), "pass");
  const w = await run("compose-env", { ".env": "FOO=1\n#C=2\nBAR=2\n", "docker-compose.yml": "services: {}\n" });
  assert.equal(w.status, "warn");
  has(w, /keys: FOO, BAR/);
  assert.ok(!/=1/.test(w.evidence), "values must not leak into evidence");
  assert.equal(await status("compose-env", { ".env": "FOO=1\n" }), "pass"); // FP: nothing auto-loads it
});

// ---------------------------------------------------------- compose-pins ---

await test("compose-pins: pinned tags + digest pass; :latest / tag-less warn; no compose = skipped", async () => {
  const ok = await run("compose-pins", { "compose.yml": "services:\n  a:\n    image: postgres:16.3\n  b:\n    image: 'redis:7' # cache\n  c:\n    image: foo/bar@sha256:abc123\n" });
  assert.equal(ok.status, "pass", ok.evidence);
  const bad = await run("compose-pins", { "docker-compose.yml": "services:\n  a:\n    image: nginx:latest\n  b:\n    image: node\n  c: { image: mysql }\n" });
  assert.equal(bad.status, "warn");
  has(bad, /nginx:latest/);
  has(bad, /docker-compose\.yml:5 → node/);
  has(bad, /docker-compose\.yml:6 → mysql/);
  assert.equal(await status("compose-pins", { "a.txt": "x" }), "skipped");
});
await test("compose-pins FP/edge: variable-substituted image is not flagged; registry:port tag-less image is", async () => {
  const ok = await run("compose-pins", { "compose.yml": "services:\n  a:\n    image: ${APP_IMAGE}\n  b:\n    image: ${REG}/app:${TAG:-1.2}\n  c:\n    image: localhost:5000/app:1.0\n" });
  assert.equal(ok.status, "pass", ok.evidence);
  const bad = await run("compose-pins", { "compose.yml": "services:\n  a:\n    image: localhost:5000/app\n" });
  assert.equal(bad.status, "warn");
});

// ---------------------------------------------------------------- levels ---

await test("levels: defaults, NANO_CHECKS_ADVISORY override, opts.levels; advisory fail -> warn (never fail)", async () => {
  assert.equal(checkLevel("deps-declared"), "gating");
  assert.equal(checkLevel("compose-pins"), "advisory");
  const failing = { "package.json": {}, "a.js": 'import x from "nope";\n' };
  const gate = await run("deps-declared", failing);
  assert.equal(gate.status, "fail");
  assert.equal(gate.level, "gating");
  process.env.NANO_CHECKS_ADVISORY = "deps-declared,env-wiring";
  try {
    assert.equal(checkLevel("deps-declared"), "advisory");
    const adv = await run("deps-declared", failing);
    assert.equal(adv.status, "warn");
    assert.equal(adv.level, "advisory");
    assert.equal(adv.rawStatus, "fail");
    has(adv, /advisory/);
    assert.ok(adv.findings.length > 0);
    process.env.NANO_CHECKS_ADVISORY = "all";
    assert.equal(checkLevel("secrets-gitleaks"), "advisory");
  } finally {
    delete process.env.NANO_CHECKS_ADVISORY;
  }
  assert.equal((await run("deps-declared", failing, { levels: { "deps-declared": "advisory" } })).status, "warn");
  assert.equal((await run("compose-pins", { "compose.yml": "services: { a: { image: x } }\n" }, { levels: { "compose-pins": "gating" } })).level, "gating");
});
await test("NANO_CHECKS disables by id or entirely (skipped, never fail)", async () => {
  const failing = { "package.json": {}, "a.js": 'import x from "nope";\n' };
  process.env.NANO_CHECKS = "deps-declared,readme-commands";
  try {
    const r = await run("deps-declared", failing);
    assert.equal(r.status, "skipped");
    has(r, /disabled via NANO_CHECKS/);
    assert.equal((await run("no-cdn-fonts", { "a.js": "x" })).status, "pass");
    process.env.NANO_CHECKS = "off";
    assert.equal((await run("no-cdn-fonts", { "a.js": "x" })).status, "skipped");
  } finally {
    delete process.env.NANO_CHECKS;
  }
});

// ------------------------------------------------- async / abort / timeout ---

await test("abort: a pre-aborted signal skips every check (no throw, no gating)", async () => {
  const ac = new AbortController();
  ac.abort();
  const all = await runMechanicalChecks({ projectPath: repo({ "package.json": {}, "a.js": 'import x from "nope"' }), signal: ac.signal });
  assert.ok(all.every((c) => c.status === "skipped"), JSON.stringify(all.map((c) => c.status)));
});
await test("abort: aborting mid-run skips the in-flight check promptly", async () => {
  const ac = new AbortController();
  const slow = (async (_c, _a, _t, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))));
  const p = run("secrets-gitleaks", { "a.js": "x" }, { exec: slow, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.status, "skipped");
  has(r, /aborted/);
  assert.ok(Date.now() - t0 < 2000);
});
await test("timeout: a hung check times out to skipped (not fail) without blocking the others", async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const all = await runMechanicalChecks({ projectPath: repo({ "package.json": { dependencies: {} }, "a.js": "x" }), exec: hang, timeoutMs: 150 });
  const sec = all.find((c) => c.id === "secrets-gitleaks");
  assert.equal(sec.status, "skipped");
  has(sec, /timed out after 150ms/);
  assert.equal(all.find((c) => c.id === "deps-declared").status, "pass");
  assert.ok(Date.now() - t0 < 3000);
});
await test("async: checks do not block the event loop during a large tree scan", async () => {
  const files = {};
  for (let i = 0; i < 400; i++) files[`src/m${i}.js`] = `import a from "./m${(i + 1) % 400}.js";\nexport default ${i};\n`;
  files["package.json"] = { name: "big" };
  const projectPath = repo(files);
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 1);
  const all = await runMechanicalChecks({ projectPath, exec: noTool });
  clearInterval(iv);
  assert.ok(all.every((c) => c.status !== "fail"));
  assert.ok(ticks > 0, "event loop never ran during the scan");
});
await test("engine contract: failing gating results are filterable by status === 'fail' with id+evidence", async () => {
  const r = await runMechanicalChecks({ projectPath: repo({ "package.json": {}, "a.js": 'import x from "nope"' }), only: ["deps-declared", "compose-pins"], exec: noTool });
  const fails = r.filter((c) => c.status === "fail");
  assert.deepEqual(fails.map((c) => c.id), ["deps-declared"]);
  assert.equal(typeof fails[0].evidence, "string");
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
