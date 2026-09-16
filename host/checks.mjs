// Driver-side mechanical checks — deterministic ground truth the verify node
// cannot argue away. Every check degrades to status "skipped" (with a reason)
// when its preconditions are absent; the module never throws and never blocks
// a run on tooling availability. Failures gate; skips never do.
//
// NANO_CHECKS env: "off" disables all checks; a comma list disables those ids
// (e.g. "deps-declared,readme-commands").
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EVIDENCE_CAP = 2000;
const WALK_OPTS = {
  // Product code only. Toolchain mirrors (.pi/.opencode/.kilo/.claude skill
  // and agent files), workflow state (.context), and non-AI product assets
  // are NOT product code — scanning them produced false-positive gaps.
  excludeDirs: new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".nano-cycle",
    ".cache",
    "web-dist",
    ".pi",
    ".opencode",
    ".kilo",
    ".claude",
    ".context",
    "not_for_ai_models",
  ]),
  maxFiles: 5000,
  maxFileBytes: 1_000_000,
};

const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
]);
const TEXT_EXTS = new Set([...CODE_EXTS, ".html", ".css", ".scss"]);

const sh = async (cmd, args, timeoutMs) =>
  execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });

// ---------------------------------------------------------------- helpers ---

/** Recursive file walk with exclusion dirs + caps. Returns absolute paths. */
function walk(root, { exts = null, maxFiles = WALK_OPTS.maxFiles } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_OPTS.excludeDirs.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        if (exts && !exts.has(path.extname(e.name).toLowerCase())) continue;
        try {
          if (fs.statSync(abs).size > WALK_OPTS.maxFileBytes) continue;
        } catch {
          continue;
        }
        out.push(abs);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function readFileLines(abs) {
  try {
    return fs.readFileSync(abs, "utf8").split("\n");
  } catch {
    return null;
  }
}

function cap(s, n = EVIDENCE_CAP) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + " …(truncated)" : str;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function disabledChecks() {
  const v = (process.env.NANO_CHECKS ?? "").trim().toLowerCase();
  if (!v) return null; // all enabled
  if (v === "off" || v === "none" || v === "false") return "all";
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

async function guard(id, title, fn) {
  const disabled = disabledChecks();
  if (disabled === "all" || disabled?.has(id)) {
    return { id, title, status: "skipped", evidence: `disabled via NANO_CHECKS` };
  }
  try {
    return await fn();
  } catch (e) {
    return { id, title, status: "skipped", evidence: `check error: ${e?.message ?? e}` };
  }
}

// ----------------------------------------------------------------- checks ---

/** gitleaks over the working tree: local binary → pinned docker → skipped. */
async function checkSecrets(projectPath) {
  const args = ["detect", "--source", projectPath, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout"];
  let stdout = "";
  let mode = "";
  let exitOne = false; // exit 1 = findings, whatever the report format did
  try {
    const r = await withTimeout(sh("gitleaks", args, 120_000), 130_000, "gitleaks");
    stdout = r.stdout ?? "";
    mode = "gitleaks binary";
  } catch (e) {
    if (e?.code === 1) {
      stdout = e.stdout ?? "";
      mode = "gitleaks binary";
      exitOne = true;
    } else {
      // no local binary (ENOENT) or unsupported flags → try docker (pinned)
      try {
        const image = process.env.NANO_GITLEAKS_IMAGE ?? "zricethezav/gitleaks:v8.24.3";
        const r = await withTimeout(
          sh("docker", ["run", "--rm", "-v", `${projectPath}:/src`, image, "detect", "--source", "/src", "--no-git", "--report-format", "json", "--report-path", "/dev/stdout"], 120_000),
          130_000,
          "gitleaks-docker",
        );
        stdout = r.stdout ?? "";
        mode = `docker ${image}`;
      } catch (e2) {
        if (e2?.code === 1) {
          stdout = e2.stdout ?? "";
          mode = `docker ${process.env.NANO_GITLEAKS_IMAGE ?? "zricethezav/gitleaks:v8.24.3"}`;
          exitOne = true;
        } else {
          return { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", status: "skipped", evidence: "gitleaks and docker unavailable" };
        }
      }
    }
  }
  let findings = [];
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    /* non-JSON report — exit code is the truth below */
  }
  if (findings.length === 0 && !exitOne) {
    return { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", status: "pass", evidence: `no secrets found (${mode})` };
  }
  if (findings.length === 0) {
    return { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", status: "fail", evidence: `gitleaks exit 1 (findings) via ${mode}; report unparseable — run it manually for details` };
  }
  const lines = findings
    .slice(0, 5)
    .map((f) => `${f.File}:${f.StartLine} (${f.RuleID})`);
  return {
    id: "secrets-gitleaks",
    title: "Secrets scan (gitleaks)",
    status: "fail",
    evidence: cap(`${findings.length} finding(s) via ${mode}: ${lines.join("; ")}`),
  };
}

/** Bare package name of an import specifier (null = not a bare dependency import). */
function bareName(specifier, aliasPrefixes, declaredLike) {
  const s = String(specifier);
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("node:") || s.startsWith("#")) return null;
  for (const pre of aliasPrefixes) {
    if (pre && s.startsWith(pre)) return null; // tsconfig paths alias
  }
  const first = s.split("/")[0];
  const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : first;
  const bare = name.split("?")[0];
  if (builtinModules.includes(bare) || builtinModules.includes(first)) return null;
  if (declaredLike.has(bare)) return null;
  return bare;
}

const IMPORT_RES = [
  /\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bimport\(\s*["']([^"'\n]+)["']/g,
  /\bexport\s+[\w$*{}\s,]*?\*?\s*(?:[\w$]+\s+)?from\s+["']([^"'\n]+)["']/g,
];

function tsconfigAliasPrefixes(pkgDir) {
  const prefixes = [];
  for (const cand of [path.join(pkgDir, "tsconfig.json"), path.join(pkgDir, "..", "tsconfig.json")]) {
    try {
      const j = JSON.parse(fs.readFileSync(cand, "utf8"));
      const paths = j?.compilerOptions?.paths ?? {};
      for (const key of Object.keys(paths)) {
        const pre = key.split("*")[0];
        if (pre) prefixes.push(pre);
      }
      if (prefixes.length > 0) return prefixes;
    } catch {
      /* try next */
    }
  }
  return prefixes;
}

/** Every bare dependency import must be declared in the governing package.json.
 *  Each manifest's scope = its own subtree minus subtrees with their own
 *  package.json (the monorepo false-positive guard). */
async function checkDepsDeclared(projectPath) {
  const manifestDirs = [projectPath];
  for (const sub of ["backend", "frontend"]) {
    const p = path.join(projectPath, sub);
    if (fs.existsSync(path.join(p, "package.json"))) manifestDirs.push(p);
  }
  const appsDir = path.join(projectPath, "apps");
  if (fs.existsSync(appsDir)) {
    for (const e of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(appsDir, e.name, "package.json"))) {
        manifestDirs.push(path.join(appsDir, e.name));
      }
    }
  }
  const manifests = manifestDirs.filter((d) => fs.existsSync(path.join(d, "package.json")));
  if (manifests.length === 0) {
    return { id: "deps-declared", title: "Dependency declarations", status: "skipped", evidence: "no package.json found" };
  }

  // A file is governed by the DEEPEST manifest dir containing it — so the root
  // manifest's scope excludes backend/frontend/apps subtrees that have their
  // own package.json (the monorepo false-positive guard).
  const manifestKeys = manifests.map((d) => ({ dir: d, key: pathKey(d) }));
  const governorOf = (abs) => {
    const key = pathKey(abs);
    let best = null;
    let bestLen = -1;
    for (const { dir, key: mk } of manifestKeys) {
      if (key === mk || key.startsWith(mk + path.sep)) {
        if (mk.length > bestLen) {
          best = dir;
          bestLen = mk.length;
        }
      }
    }
    return best;
  };
  const configNameRe = /^(eslint\.config\.|\.eslintrc|\.prettierrc|prettier\.config\.|vite\.config\.|vitest\.config\.|jest\.config\.|tsconfig)/;

  // Group source files by governing manifest in one walk from the project root.
  const filesByManifest = new Map();
  for (const abs of walk(projectPath, { exts: CODE_EXTS })) {
    const gov = governorOf(abs);
    if (!gov) continue;
    if (!filesByManifest.has(gov)) filesByManifest.set(gov, []);
    filesByManifest.get(gov).push(abs);
  }

  const problems = [];
  for (const dir of manifests) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const declared = new Set(
      [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ].map((k) => k.split("?")[0]),
    );
    const aliases = tsconfigAliasPrefixes(dir);
    const undeclared = new Map(); // name -> [file:line]
    const files = filesByManifest.get(dir) ?? [];
    for (const abs of files) {
      const rel = path.relative(projectPath, abs);
      const lines = readFileLines(abs);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        for (const re of IMPORT_RES) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(lines[i])) !== null) {
            const name = bareName(m[1], aliases, declared);
            if (!name) continue;
            if (!undeclared.has(name)) undeclared.set(name, []);
            if (undeclared.get(name).length < 5) undeclared.get(name).push(`${rel}:${i + 1}`);
          }
        }
      }
    }
    // eslint/prettier/vite config files at the manifest root also reference
    // packages — via real import/require statements and `plugins:` array
    // entries ONLY. Arbitrary quoted strings are NOT imports (an eslint
    // `ignores: ["dist", "coverage"]` glob once masqueraded as one and burned
    // two fix rounds).
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || !configNameRe.test(e.name)) continue;
        if (!/\.(js|cjs|mjs|ts)$/.test(e.name)) continue;
        const lines = readFileLines(path.join(dir, e.name));
        if (!lines) continue;
        const rel = `${path.relative(projectPath, dir)}/${e.name}`;
        const record = (name, line) => {
          if (!name) return;
          if (!undeclared.has(name)) undeclared.set(name, []);
          if (undeclared.get(name).length < 5) undeclared.get(name).push(`${rel}:${line}`);
        };
        for (let i = 0; i < lines.length; i++) {
          for (const re of IMPORT_RES) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(lines[i])) !== null) record(bareName(m[1], aliases, declared), i + 1);
          }
          // `plugins: ["pkg", ...]` entries are package references
          const plug = lines[i].match(/plugins\s*:\s*\[([^\]]*)\]/);
          if (plug) {
            for (const q of plug[1].match(/["']([^"'\n]+)["']/g) ?? []) {
              record(bareName(q.slice(1, -1), aliases, declared), i + 1);
            }
          }
        }
      }
    } catch {
      /* config scan is best-effort */
    }
    if (undeclared.size > 0) {
      const scope = dir === projectPath ? "root" : path.relative(projectPath, dir);
      const items = [...undeclared.entries()].map(([n, locs]) => `${n} (${locs.join(", ")})`);
      problems.push(`${scope}/package.json — imported but undeclared: ${items.join("; ")}`);
    }
  }
  if (problems.length > 0) {
    return { id: "deps-declared", title: "Dependency declarations", status: "fail", evidence: cap(problems.join(" | ")) };
  }
  return { id: "deps-declared", title: "Dependency declarations", status: "pass", evidence: "every bare import is declared in its governing package.json" };
}

function pathKey(p) {
  return path.normalize(String(p)).toLowerCase();
}

/** No external font-CDN references in shipped code — the tofu failure mode's
 *  source. References confined to docs/ (design sources, demo HTML) are a
 *  non-gating warning; anything in app code fails. */
async function checkNoCdnFonts(projectPath) {
  const re = /fonts\.(googleapis|gstatic)\.com/;
  const codeHits = [];
  const docHits = [];
  for (const abs of walk(projectPath, { exts: TEXT_EXTS })) {
    const rel = path.relative(projectPath, abs);
    const lines = readFileLines(abs);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const entry = `${rel}:${i + 1}`;
      if (/(^|\/)docs\//.test(rel)) docHits.push(entry);
      else codeHits.push(entry);
      if (codeHits.length + docHits.length >= 10) break;
    }
    if (codeHits.length + docHits.length >= 10) break;
  }
  if (codeHits.length > 0) {
    const docNote = docHits.length ? ` (${docHits.length} more under docs/ — warnings)` : "";
    return {
      id: "no-cdn-fonts",
      title: "Local font loading (no font CDN)",
      status: "fail",
      evidence: cap(`font-CDN references in app code (bundle fonts locally instead — a blocked/flaky CDN renders missing-glyph tofu): ${codeHits.join("; ")}${docNote}`),
    };
  }
  if (docHits.length > 0) {
    return {
      id: "no-cdn-fonts",
      title: "Local font loading (no font CDN)",
      status: "warn",
      evidence: cap(`font-CDN references only under docs/ (design sources, not shipped code) — recorded as a warning, not gated: ${docHits.join("; ")}`),
    };
  }
  return { id: "no-cdn-fonts", title: "Local font loading (no font CDN)", status: "pass", evidence: "no fonts.googleapis.com/gstatic references in source" };
}

function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenKeys(v, key));
    else out.push(key);
  }
  return out;
}

/** en/bn locale JSON pairs must cover the same key set. */
async function checkI18nParity(projectPath) {
  const pairs = new Map(); // dir -> {en: Set, bn: Set}
  for (const abs of walk(projectPath, { exts: new Set([".json"]) })) {
    const base = path.basename(abs).toLowerCase();
    if (base !== "en.json" && base !== "bn.json") continue;
    const lang = base.slice(0, 2);
    const dir = path.dirname(abs);
    if (!pairs.has(dir)) pairs.set(dir, {});
    try {
      const j = JSON.parse(fs.readFileSync(abs, "utf8"));
      pairs.get(dir)[lang] = new Set(flattenKeys(j));
    } catch {
      /* unparsable locale file — skip the pair */
    }
  }
  const usable = [...pairs.entries()].filter(([, v]) => v.en && v.bn);
  if (usable.length === 0) {
    return { id: "i18n-parity", title: "Locale key parity (en/bn)", status: "skipped", evidence: "no en.json/bn.json pairs found" };
  }
  const problems = [];
  for (const [dir, { en, bn }] of usable) {
    const missingBn = [...en].filter((k) => !bn.has(k));
    const missingEn = [...bn].filter((k) => !en.has(k));
    if (missingBn.length) problems.push(`${path.relative(projectPath, dir)}: missing in bn — ${missingBn.slice(0, 8).join(", ")}${missingBn.length > 8 ? " …" : ""}`);
    if (missingEn.length) problems.push(`${path.relative(projectPath, dir)}: missing in en — ${missingEn.slice(0, 8).join(", ")}${missingEn.length > 8 ? " …" : ""}`);
  }
  if (problems.length > 0) {
    return { id: "i18n-parity", title: "Locale key parity (en/bn)", status: "fail", evidence: cap(problems.join(" | ")) };
  }
  return { id: "i18n-parity", title: "Locale key parity (en/bn)", status: "pass", evidence: `${usable.length} locale pair(s) with identical key sets` };
}

const PUBLIC_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", "EXPO_PUBLIC_", "NUXT_ENV_", "GATSBY_"];
function normEnvKey(k) {
  let s = String(k).toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const pre of PUBLIC_PREFIXES) {
    if (s.startsWith(pre)) {
      s = s.slice(pre.length);
      break;
    }
  }
  return s;
}

/** .env.example keys ↔ process.env/import.meta.env reads, both directions. */
async function checkEnvWiring(projectPath) {
  const examples = walk(projectPath, { exts: null })
    .filter((abs) => {
      const b = path.basename(abs).toLowerCase();
      return b === ".env.example" || b === ".env.sample";
    });
  if (examples.length === 0) {
    return { id: "env-wiring", title: "Env template wiring", status: "skipped", evidence: "no .env.example found" };
  }
  const declared = new Set();
  for (const abs of examples) {
    for (const line of readFileLines(abs) ?? []) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && !line.trim().startsWith("#")) declared.add(m[1]);
    }
  }
  const reads = new Map(); // raw name -> [file:line]
  for (const abs of walk(projectPath, { exts: CODE_EXTS })) {
    const lines = readFileLines(abs);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(/\b(?:process\.env|import\.meta\.env)\.([A-Z0-9_]+)/g);
      for (const m of matches) {
        if (!reads.has(m[1])) reads.set(m[1], []);
        if (reads.get(m[1]).length < 4) reads.get(m[1]).push(`${path.relative(projectPath, abs)}:${i + 1}`);
      }
    }
  }
  const declaredNorm = new Map([...declared].map((k) => [normEnvKey(k), k]));
  const problems = [];
  for (const [raw, locs] of reads.entries()) {
    if (!declaredNorm.has(normEnvKey(raw))) {
      problems.push(`read but not in any .env.example: ${raw} (${locs.join(", ")})`);
    }
  }
  const readNorms = new Set([...reads.keys()].map(normEnvKey));
  const unread = [...declared].filter((k) => !readNorms.has(normEnvKey(k)));
  if (unread.length) problems.push(`declared but never read: ${unread.join(", ")}`);
  if (problems.length > 0) {
    return { id: "env-wiring", title: "Env template wiring", status: "fail", evidence: cap(problems.join(" | ")) };
  }
  return { id: "env-wiring", title: "Env template wiring", status: "pass", evidence: `${declared.size} declared key(s) ↔ ${reads.size} read key(s), fully reconciled` };
}

/** Every npm-run / ./scripts/ command the README documents must resolve. */
async function checkReadmeCommands(projectPath) {
  const readme = path.join(projectPath, "README.md");
  const rootPkgPath = path.join(projectPath, "package.json");
  if (!fs.existsSync(readme) || !fs.existsSync(rootPkgPath)) {
    return { id: "readme-commands", title: "README command truth", status: "skipped", evidence: "no README.md or no root package.json" };
  }
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const lines = readFileLines(readme) ?? [];
  const problems = [];
  const npxMentions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)(?:\s+(?:-w|--workspace)\s+(\S+))?/g)) {
      const [, script, ws] = m;
      let scripts = rootPkg.scripts ?? {};
      let where = "root package.json";
      if (ws) {
        const wsPkg = path.join(projectPath, ws.replace(/^packages?\//, ""), "package.json");
        try {
          scripts = JSON.parse(fs.readFileSync(wsPkg, "utf8")).scripts ?? {};
          where = `${ws}/package.json`;
        } catch {
          problems.push(`README:${i + 1} — "npm run ${script}" targets unknown workspace ${ws}`);
          continue;
        }
      }
      if (!(script in scripts)) problems.push(`README:${i + 1} — "npm run ${script}" has no such script in ${where}`);
    }
    for (const m of line.matchAll(/(\.\/scripts\/[\w./-]+)/g)) {
      if (!fs.existsSync(path.resolve(projectPath, m[1]))) {
        problems.push(`README:${i + 1} — "${m[1]}" does not exist`);
      }
    }
    for (const m of line.matchAll(/\bnpx\s+([@\w/.-]+)/g)) npxMentions.push(m[1]);
  }
  if (problems.length > 0) {
    return { id: "readme-commands", title: "README command truth", status: "fail", evidence: cap(problems.join(" | ")) };
  }
  const npxNote = npxMentions.length ? ` (${npxMentions.length} npx mention(s), informational)` : "";
  return { id: "readme-commands", title: "README command truth", status: "pass", evidence: `every documented npm-run / scripts command resolves${npxNote}` };
}

// ------------------------------------------------------------------ entry ---

/** Run all mechanical checks. Never throws; each check returns
 *  { id, title, status: "pass"|"warn"|"fail"|"skipped", evidence }.
 *  Only "fail" gates; "warn" is recorded for the owner without a fix round. */
export async function runMechanicalChecks({ projectPath, runId, emit }) {
  void runId;
  void emit; // reserved for per-check progress if ever needed
  const results = await Promise.all([
    guard("secrets-gitleaks", "Secrets scan (gitleaks)", () => checkSecrets(projectPath)),
    guard("deps-declared", "Dependency declarations", () => checkDepsDeclared(projectPath)),
    guard("no-cdn-fonts", "Local font loading (no font CDN)", () => checkNoCdnFonts(projectPath)),
    guard("i18n-parity", "Locale key parity (en/bn)", () => checkI18nParity(projectPath)),
    guard("env-wiring", "Env template wiring", () => checkEnvWiring(projectPath)),
    guard("readme-commands", "README command truth", () => checkReadmeCommands(projectPath)),
  ]);
  return results;
}
