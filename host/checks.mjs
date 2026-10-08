// Driver-side mechanical checks — deterministic ground truth the verify node
// cannot argue away. Every check degrades to status "skipped" (with a reason)
// when its preconditions are absent; the module never throws and never blocks
// a run on tooling availability. Failures gate; skips never do.
//
// Every check is async and abortable: no sync tree walks or spawnSync on the
// event loop, each check runs under a per-check timeout and the caller's
// AbortSignal (a timeout/abort degrades to "skipped" — it never gates).
//
// Result shape (engine-compatible): { id, title, level, status, evidence,
// findings[] } where status is "pass" | "warn" | "fail" | "skipped" and
// findings is [{ message, file?, line? }]. `evidence` is the human summary the
// engine/verifier prompt already consume.
//
// Levels: each check is "gating" or "advisory" (default table CHECK_DEFS).
// An advisory check that would fail is reported as status "warn" (with
// rawStatus "fail") and never gates. Only a gating "fail" gates.
//
// Env:
//   NANO_CHECKS="off"            disables all checks; a comma list disables
//                                those ids (e.g. "deps-declared,readme-commands").
//   NANO_CHECKS_ADVISORY="a,b"   demotes those ids to advisory ("all" = every check).
//   NANO_CHECK_TIMEOUT_MS        per-check timeout (default 180000).
//   NANO_EXCLUDE_DIRS="d1,d2"    extra excluded directories for tree walks.
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EVIDENCE_CAP = 2000;
const WALK_OPTS = {
  // Product code only. Toolchain mirrors (.pi/.opencode/.kilo/.claude skill
  // and agent files) and workflow state (.context) are NOT product code —
  // scanning them produced false-positive gaps. Extra per-project exclusions:
  // NANO_EXCLUDE_DIRS="dir1,dir2".
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
  ]),
  maxFiles: 5000,
  maxEntries: 50_000, // hard bound on the shared listing
  maxFileBytes: 1_000_000,
  concurrency: 16,
};
for (const d of (process.env.NANO_EXCLUDE_DIRS ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
  WALK_OPTS.excludeDirs.add(d);
}

const CODE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]);
const TEXT_EXTS = new Set([...CODE_EXTS, ".html", ".css", ".scss"]);
// Non-JS sources/config that legitimately consume env vars (env-wiring "is it read" scan).
const OTHER_ENV_CONSUMER_EXTS = new Set([".py", ".go", ".rb", ".php", ".java", ".kt", ".rs", ".cs", ".sh", ".bash", ".ex", ".exs"]);

const sh = (cmd, args, timeoutMs, signal) =>
  execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal });

// ---------------------------------------------------------------- helpers ---

function cap(s, n = EVIDENCE_CAP) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + " …(truncated)" : str;
}

const res = (status, evidence, findings = []) => ({ status, evidence, findings });
const finding = (message, file, line) => ({ message, ...(file ? { file } : {}), ...(line ? { line } : {}) });

function pathKey(p) {
  return path.normalize(String(p)).toLowerCase();
}

/** Resolve `target` against `base`; null when it escapes `root` (containment via path.relative). */
function insideRoot(root, base, target) {
  const abs = path.resolve(base, target);
  const rel = path.relative(root, abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
  return null;
}

async function mapLimit(items, limit, signal, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Shared per-run state: one async tree listing + a bounded text cache that all
 *  checks reuse, so N checks do not each re-walk the tree. */
function makeShared(projectPath, runSignal, exec) {
  const textCache = new Map();
  let cachedBytes = 0;
  let listing = null;

  async function list() {
    const out = [];
    const stack = [projectPath];
    while (stack.length > 0 && out.length < WALK_OPTS.maxEntries) {
      runSignal?.throwIfAborted();
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!WALK_OPTS.excludeDirs.has(e.name)) stack.push(abs);
        } else if (e.isFile()) {
          out.push(abs);
          if (out.length >= WALK_OPTS.maxEntries) break;
        }
      }
    }
    return out;
  }

  return {
    projectPath,
    exec,
    listing: () => (listing ??= list()),
    textCache,
    addCached(n) {
      cachedBytes += n;
      return cachedBytes <= 64 * 1024 * 1024;
    },
  };
}

/** Per-check view of the shared state, bound to that check's abort signal. */
function makeCtx(shared, signal) {
  const ctx = {
    projectPath: shared.projectPath,
    signal,
    exec: shared.exec,
    rel: (abs) => path.relative(shared.projectPath, abs),
    /** Files matching an extension Set or a predicate(abs) — capped at maxFiles. */
    async files(match) {
      const all = await shared.listing();
      signal.throwIfAborted();
      const pred = typeof match === "function" ? match : (abs) => match.has(path.extname(abs).toLowerCase());
      const out = [];
      for (const abs of all) {
        if (pred(abs)) {
          out.push(abs);
          if (out.length >= WALK_OPTS.maxFiles) break;
        }
      }
      return out;
    },
    /** File text, or null when unreadable / over the size cap. */
    async text(abs) {
      signal.throwIfAborted();
      if (shared.textCache.has(abs)) return shared.textCache.get(abs);
      let text = null;
      try {
        const st = await fsp.stat(abs);
        if (st.isFile() && st.size <= WALK_OPTS.maxFileBytes) text = await fsp.readFile(abs, "utf8");
      } catch {
        text = null;
      }
      signal.throwIfAborted();
      if (text !== null && shared.addCached(text.length)) shared.textCache.set(abs, text);
      return text;
    },
    async lines(abs) {
      const t = await ctx.text(abs);
      return t === null ? null : t.split("\n");
    },
    async exists(abs) {
      try {
        await fsp.access(abs);
        return true;
      } catch {
        return false;
      }
    },
    async isDir(abs) {
      try {
        return (await fsp.stat(abs)).isDirectory();
      } catch {
        return false;
      }
    },
    async json(abs) {
      const t = await ctx.text(abs);
      if (t === null) return null;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
    async rootEntries() {
      try {
        return await fsp.readdir(shared.projectPath, { withFileTypes: true });
      } catch {
        return [];
      }
    },
    /** Run `fn(item)` over items with bounded concurrency, honouring the abort signal. */
    each: (items, fn) => mapLimit(items, WALK_OPTS.concurrency, signal, fn),
  };
  return ctx;
}

function lineOf(text, idx) {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < idx; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

// ----------------------------------------------------------------- checks ---

/** gitleaks over the working tree: local binary → pinned docker → skipped. */
async function checkSecrets(ctx) {
  const { projectPath, signal } = ctx;
  const run = ctx.exec ?? sh;
  const args = ["detect", "--source", projectPath, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout"];
  let stdout = "";
  let mode = "";
  let exitOne = false; // exit 1 = findings, whatever the report format did
  try {
    const r = await run("gitleaks", args, 120_000, signal);
    stdout = r.stdout ?? "";
    mode = "gitleaks binary";
  } catch (e) {
    signal.throwIfAborted();
    if (e?.code === 1) {
      stdout = e.stdout ?? "";
      mode = "gitleaks binary";
      exitOne = true;
    } else {
      // no local binary (ENOENT) or unsupported flags → try docker (pinned)
      const image = process.env.NANO_GITLEAKS_IMAGE ?? "zricethezav/gitleaks:v8.24.3";
      try {
        const r = await run(
          "docker",
          ["run", "--rm", "-v", `${projectPath}:/src`, image, "detect", "--source", "/src", "--no-git", "--report-format", "json", "--report-path", "/dev/stdout"],
          120_000,
          signal,
        );
        stdout = r.stdout ?? "";
        mode = `docker ${image}`;
      } catch (e2) {
        signal.throwIfAborted();
        if (e2?.code === 1) {
          stdout = e2.stdout ?? "";
          mode = `docker ${image}`;
          exitOne = true;
        } else {
          return res("skipped", "gitleaks and docker unavailable");
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
  if (findings.length === 0 && !exitOne) return res("pass", `no secrets found (${mode})`);
  if (findings.length === 0) {
    return res("fail", `gitleaks exit 1 (findings) via ${mode}; report unparseable — run it manually for details`, [
      finding("gitleaks reported findings but its report could not be parsed"),
    ]);
  }
  const lines = findings.slice(0, 5).map((f) => `${f.File}:${f.StartLine} (${f.RuleID})`);
  return res(
    "fail",
    cap(`${findings.length} finding(s) via ${mode}: ${lines.join("; ")}`),
    findings.slice(0, 20).map((f) => finding(`secret detected (${f.RuleID})`, f.File, f.StartLine)),
  );
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

async function tsconfigAliasPrefixes(ctx, pkgDir) {
  const prefixes = [];
  for (const cand of [path.join(pkgDir, "tsconfig.json"), path.join(pkgDir, "..", "tsconfig.json")]) {
    const j = await ctx.json(cand);
    if (!j) continue;
    const paths = j?.compilerOptions?.paths ?? {};
    for (const key of Object.keys(paths)) {
      const pre = key.split("*")[0];
      if (pre) prefixes.push(pre);
    }
    if (prefixes.length > 0) return prefixes;
  }
  return prefixes;
}

/** Every bare dependency import must be declared in the governing package.json.
 *  Each manifest's scope = its own subtree minus subtrees with their own
 *  package.json (the monorepo false-positive guard). */
async function checkDepsDeclared(ctx) {
  const { projectPath } = ctx;
  // Layout-agnostic: every package.json in the tree (the listing already excludes
  // node_modules/toolchain dirs) governs its own subtree minus deeper
  // manifests — monorepo shapes are discovered, never hardcoded.
  const manifests = [
    ...new Set((await ctx.files((abs) => path.basename(abs) === "package.json")).map((abs) => path.dirname(abs))),
  ];
  if (manifests.length === 0) return res("skipped", "no package.json found");

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

  // Group source files by governing manifest.
  const filesByManifest = new Map();
  for (const abs of await ctx.files(CODE_EXTS)) {
    const gov = governorOf(abs);
    if (!gov) continue;
    if (!filesByManifest.has(gov)) filesByManifest.set(gov, []);
    filesByManifest.get(gov).push(abs);
  }

  const problems = [];
  const findings = [];
  for (const dir of manifests) {
    const pkg = await ctx.json(path.join(dir, "package.json"));
    if (!pkg) continue; // unparsable manifest is not this check's finding
    const declared = new Set(
      [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ].map((k) => k.split("?")[0]),
    );
    const aliases = await tsconfigAliasPrefixes(ctx, dir);
    const undeclared = new Map(); // name -> [file:line]
    const record = (name, rel, line) => {
      if (!name) return;
      if (!undeclared.has(name)) undeclared.set(name, []);
      if (undeclared.get(name).length < 5) undeclared.get(name).push({ rel, line });
    };
    await ctx.each(filesByManifest.get(dir) ?? [], async (abs) => {
      const rel = ctx.rel(abs);
      const lines = await ctx.lines(abs);
      if (!lines) return;
      for (let i = 0; i < lines.length; i++) {
        for (const re of IMPORT_RES) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(lines[i])) !== null) record(bareName(m[1], aliases, declared), rel, i + 1);
        }
      }
    });
    // eslint/prettier/vite config files at the manifest root also reference
    // packages — via real import/require statements and `plugins:` array
    // entries ONLY. Arbitrary quoted strings are NOT imports (an eslint
    // `ignores: ["dist", "coverage"]` glob once masqueraded as one and burned
    // two fix rounds).
    try {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!e.isFile() || !configNameRe.test(e.name)) continue;
        if (!/\.(js|cjs|mjs|ts)$/.test(e.name)) continue;
        const lines = await ctx.lines(path.join(dir, e.name));
        if (!lines) continue;
        const rel = `${path.relative(projectPath, dir)}/${e.name}`;
        for (let i = 0; i < lines.length; i++) {
          for (const re of IMPORT_RES) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(lines[i])) !== null) record(bareName(m[1], aliases, declared), rel, i + 1);
          }
          // `plugins: ["pkg", ...]` entries are package references
          const plug = lines[i].match(/plugins\s*:\s*\[([^\]]*)\]/);
          if (plug) {
            for (const q of plug[1].match(/["']([^"'\n]+)["']/g) ?? []) {
              record(bareName(q.slice(1, -1), aliases, declared), rel, i + 1);
            }
          }
        }
      }
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      /* config scan is best-effort */
    }
    if (undeclared.size > 0) {
      const scope = dir === projectPath ? "root" : path.relative(projectPath, dir);
      const items = [...undeclared.entries()].map(([n, locs]) => `${n} (${locs.map((l) => `${l.rel}:${l.line}`).join(", ")})`);
      problems.push(`${scope}/package.json — imported but undeclared: ${items.join("; ")}`);
      for (const [n, locs] of undeclared) {
        findings.push(finding(`${n} is imported but undeclared in ${scope}/package.json`, locs[0].rel, locs[0].line));
      }
    }
  }
  if (problems.length > 0) return res("fail", cap(problems.join(" | ")), findings);
  return res("pass", "every bare import is declared in its governing package.json");
}

/** No external font-CDN references in shipped code — the tofu failure mode's
 *  source. References confined to docs/ (design sources, demo HTML) are a
 *  non-gating warning; anything in app code fails. */
async function checkNoCdnFonts(ctx) {
  const re = /fonts\.(googleapis|gstatic)\.com/;
  const codeHits = [];
  const docHits = [];
  const files = (await ctx.files(TEXT_EXTS)).sort();
  for (const abs of files) {
    if (codeHits.length + docHits.length >= 10) break;
    const rel = ctx.rel(abs);
    const lines = await ctx.lines(abs);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const entry = { rel, line: i + 1 };
      if (/(^|\/)docs\//.test(rel)) docHits.push(entry);
      else codeHits.push(entry);
      if (codeHits.length + docHits.length >= 10) break;
    }
  }
  const fmt = (hits) => hits.map((h) => `${h.rel}:${h.line}`).join("; ");
  if (codeHits.length > 0) {
    const docNote = docHits.length ? ` (${docHits.length} more under docs/ — warnings)` : "";
    return res(
      "fail",
      cap(`font-CDN references in app code (bundle fonts locally instead — a blocked/flaky CDN renders missing-glyph tofu): ${fmt(codeHits)}${docNote}`),
      codeHits.map((h) => finding("font-CDN reference in app code", h.rel, h.line)),
    );
  }
  if (docHits.length > 0) {
    return res(
      "warn",
      cap(`font-CDN references only under docs/ (design sources, not shipped code) — recorded as a warning, not gated: ${fmt(docHits)}`),
      docHits.map((h) => finding("font-CDN reference under docs/", h.rel, h.line)),
    );
  }
  return res("pass", "no fonts.googleapis.com/gstatic references in source");
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

/** Locale JSON sets must cover the same key set — any language set the
 *  project itself defines (en+bn, en+fr, …). A set is 2+ `xx.json` /
 *  `xx-YY.json` files that are siblings in a directory *named* like a locale
 *  folder (locales/ i18n/ messages/ lang/ …) — two stray two-letter .json files
 *  elsewhere (`db.json`, `ui.json`) are NOT a locale set. Parity is required
 *  across ALL members, in every direction.
 */
const LOCALE_FILE_RE = /^([a-z]{2}(?:[-_][A-Za-z]{2,4})?)\.json$/;
const LOCALE_DIR_RE = /^(locales?|i18n|l10n|intl|messages|lang|langs|languages|translations?)$/i;
async function checkI18nParity(ctx) {
  const sets = new Map(); // dir -> Map(locale stem -> Set(keys))
  const candidates = await ctx.files((abs) => LOCALE_FILE_RE.test(path.basename(abs)) && LOCALE_DIR_RE.test(path.basename(path.dirname(abs))));
  await ctx.each(candidates, async (abs) => {
    const stem = path.basename(abs).match(LOCALE_FILE_RE)[1].replace("_", "-");
    const dir = path.dirname(abs);
    const j = await ctx.json(abs); // unparsable locale file — skipped
    if (!j || typeof j !== "object" || Array.isArray(j)) return;
    if (!sets.has(dir)) sets.set(dir, new Map());
    sets.get(dir).set(stem, new Set(flattenKeys(j)));
  });
  const usable = [...sets.entries()].filter(([, langs]) => langs.size >= 2);
  if (usable.length === 0) {
    return res("skipped", "no locale file sets found (2+ xx.json / xx-YY.json files in a locales/ i18n/ messages/ lang/ directory)");
  }
  const problems = [];
  const findings = [];
  for (const [dir, langs] of usable) {
    const names = [...langs.keys()];
    const union = new Set(names.flatMap((l) => [...langs.get(l)]));
    for (const l of names) {
      const missing = [...union].filter((k) => !langs.get(l).has(k));
      if (missing.length) {
        const rel = path.relative(ctx.projectPath, dir);
        problems.push(`${rel}: missing in ${l} — ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
        findings.push(finding(`locale ${l} is missing ${missing.length} key(s): ${missing.slice(0, 8).join(", ")}`, path.join(rel, `${l}.json`)));
      }
    }
  }
  if (problems.length > 0) return res("fail", cap(problems.join(" | ")), findings);
  return res("pass", `${usable.length} locale set(s) with identical key sets across all languages`);
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

// Variables the platform/toolchain provides — reading them never needs a
// .env.example entry. Vite's import.meta.env built-ins are scoped to import.meta.
const AMBIENT_ENV = new Set([
  "NODE_ENV", "CI", "HOME", "PATH", "PWD", "USER", "USERNAME", "SHELL", "TERM", "TZ", "LANG", "TMPDIR", "TEMP", "TMP",
  "HOSTNAME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "FORCE_COLOR", "NO_COLOR", "NODE_OPTIONS", "DEBUG",
]);
const AMBIENT_ENV_RE = /^(npm_|GITHUB_|XDG_|LC_)/;
const AMBIENT_META = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

const ENV_SRC = String.raw`(?:process\.env|import\.meta\.env)`;

/** Env reads in one source file: dotted, `["LIT"]`, and destructuring forms.
 *  `dynamic` = an access the scan cannot resolve to a name (`env[k]`, spread, `{...rest}`). */
function scanEnvReads(text) {
  const reads = []; // { name, line, meta }
  let dynamic = false;
  const add = (name, idx, meta) => reads.push({ name, line: lineOf(text, idx), meta });
  for (const m of text.matchAll(new RegExp(String.raw`\b(${ENV_SRC})\??\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) {
    add(m[2], m.index, m[1].startsWith("import"));
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b(${ENV_SRC})\s*\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*\]`, "g"))) {
    add(m[3], m.index, m[1].startsWith("import"));
  }
  // env[expr] where expr is not a plain string literal
  if (new RegExp(String.raw`\b${ENV_SRC}\s*\[\s*(?!(["'])[A-Za-z_][A-Za-z0-9_]*\1\s*\])`).test(text)) dynamic = true;
  if (new RegExp(String.raw`\.\.\.\s*${ENV_SRC}\b|Object\.(?:keys|entries|values)\(\s*${ENV_SRC}\s*\)`).test(text)) dynamic = true;
  // const { A, B: b, C = 'x', ...rest } = process.env
  for (const m of text.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(${ENV_SRC})\b(?!\s*[.\[])`, "g"))) {
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const part of body.split(",")) {
      const p = part.trim();
      if (!p) continue;
      if (p.startsWith("...")) {
        dynamic = true;
        continue;
      }
      const nm = p.match(/^(?:([A-Za-z_]\w*)|["']([^"']+)["'])\s*(?::|=|$)/);
      if (nm) add(nm[1] ?? nm[2], m.index, m[2].startsWith("import"));
    }
  }
  return { reads, dynamic };
}

/** .env.example keys ↔ env reads (process.env / import.meta.env, dotted /
 *  bracketed / destructured), plus compose `environment:`/`env_file:` and
 *  non-JS consumers, both directions. */
async function checkEnvWiring(ctx) {
  const examples = await ctx.files((abs) => {
    const b = path.basename(abs).toLowerCase();
    return b === ".env.example" || b === ".env.sample";
  });
  if (examples.length === 0) return res("skipped", "no .env.example found");
  const declared = new Set();
  for (const abs of examples) {
    for (const line of (await ctx.lines(abs)) ?? []) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && !line.trim().startsWith("#")) declared.add(m[1]);
    }
  }
  const reads = new Map(); // raw name -> [{rel,line}]
  const metaOnly = new Map(); // raw name -> true while only import.meta reads seen
  const quoted = new Set(); // string-literal names (resolve dynamic env[k] callers)
  let dynamicAccess = false;
  await ctx.each(await ctx.files(CODE_EXTS), async (abs) => {
    const text = await ctx.text(abs);
    if (!text) return;
    const rel = ctx.rel(abs);
    const r = scanEnvReads(text);
    if (r.dynamic) {
      dynamicAccess = true;
      for (const q of text.matchAll(/["'`]([A-Z][A-Z0-9_]+)["'`]/g)) quoted.add(q[1]);
    }
    for (const { name, line, meta } of r.reads) {
      if (!reads.has(name)) reads.set(name, []);
      if (reads.get(name).length < 4) reads.get(name).push({ rel, line });
      metaOnly.set(name, (metaOnly.get(name) ?? true) && meta);
    }
  });

  // Declared keys consumed outside JS: compose files (environment:, ${VAR}
  // interpolation, env_file passthrough), Dockerfiles, and other-language code.
  const consumerWords = new Set();
  let envFilePassthrough = false;
  const consumers = await ctx.files((abs) => {
    const b = path.basename(abs).toLowerCase();
    return /^(docker-)?compose[^/]*\.ya?ml$/.test(b) || b.startsWith("dockerfile") || OTHER_ENV_CONSUMER_EXTS.has(path.extname(b));
  });
  await ctx.each(consumers, async (abs) => {
    const text = await ctx.text(abs);
    if (!text) return;
    if (/^(docker-)?compose[^/]*\.ya?ml$/i.test(path.basename(abs)) && /^\s*env_file\s*:/m.test(text)) envFilePassthrough = true;
    for (const w of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) consumerWords.add(w[0]);
  });

  const declaredNorm = new Map([...declared].map((k) => [normEnvKey(k), k]));
  const problems = [];
  const findings = [];
  for (const [raw, locs] of reads.entries()) {
    if (AMBIENT_ENV.has(raw) || AMBIENT_ENV_RE.test(raw)) continue;
    if (metaOnly.get(raw) && AMBIENT_META.has(raw)) continue;
    if (!declaredNorm.has(normEnvKey(raw))) {
      problems.push(`read but not in any .env.example: ${raw} (${locs.map((l) => `${l.rel}:${l.line}`).join(", ")})`);
      findings.push(finding(`${raw} is read but missing from .env.example`, locs[0].rel, locs[0].line));
    }
  }
  const readNorms = new Set([...reads.keys()].map(normEnvKey));
  let unread = [];
  if (!envFilePassthrough) {
    unread = [...declared].filter((k) => {
      const n = normEnvKey(k);
      if (readNorms.has(n) || consumerWords.has(k)) return false;
      if (dynamicAccess && quoted.has(k)) return false; // referenced by name where env[k] is used
      return true;
    });
  }
  if (unread.length) {
    problems.push(`declared but never read: ${unread.join(", ")}`);
    for (const k of unread) findings.push(finding(`${k} is declared in .env.example but never read`));
  }
  if (problems.length > 0) return res("fail", cap(problems.join(" | ")), findings);
  return res("pass", `${declared.size} declared key(s) ↔ ${reads.size} read key(s), fully reconciled`);
}

// ------------------------------------------------------------ readme-commands

const NPM_FLAGS_WITH_VALUE = new Set(["-w", "--workspace", "--prefix", "-C", "--cwd"]);

/** Parse the argument string after `npm`. Returns { script, workspaces[], prefix,
 *  allWorkspaces, ifPresent } for `npm run <script>` forms (flags may appear
 *  before or after `run`), or null for anything else. */
function parseNpmRun(argStr) {
  const toks = argStr.trim().split(/\s+/).filter(Boolean);
  const o = { script: null, workspaces: [], prefix: null, allWorkspaces: false, ifPresent: false };
  let cmd = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") break;
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const flag = eq === -1 ? t : t.slice(0, eq);
      if (NPM_FLAGS_WITH_VALUE.has(flag)) {
        const val = eq === -1 ? toks[++i] : t.slice(eq + 1);
        if (val === undefined) return null;
        if (flag === "-w" || flag === "--workspace") o.workspaces.push(val);
        else o.prefix = val;
      } else if (flag === "--workspaces" || flag === "-ws") o.allWorkspaces = true;
      else if (flag === "--if-present") o.ifPresent = true;
      continue;
    }
    if (cmd === null) {
      if (t !== "run" && t !== "run-script") return null;
      cmd = t;
      continue;
    }
    const m = t.match(/^([A-Za-z0-9:_-]+)[.,;)]*$/); // prose/code-span trailing punctuation
    if (!m) return null; // placeholder like <name>
    if (!o.script) o.script = m[1]; // later positionals are script args; flags after the script still apply
  }
  return o.script ? o : null;
}

/** Every npm-run / ./scripts/ command the README documents must resolve. */
async function checkReadmeCommands(ctx) {
  const { projectPath } = ctx;
  const readme = path.join(projectPath, "README.md");
  const rootPkgPath = path.join(projectPath, "package.json");
  if (!(await ctx.exists(readme)) || !(await ctx.exists(rootPkgPath))) {
    return res("skipped", "no README.md or no root package.json");
  }
  const rootPkg = (await ctx.json(rootPkgPath)) ?? {};
  const lines = (await ctx.lines(readme)) ?? [];

  // Lazy manifest index for workspace-by-name lookup and --workspaces.
  let manifestIdx = null;
  const manifests = async () => {
    if (manifestIdx) return manifestIdx;
    manifestIdx = [];
    for (const abs of await ctx.files((a) => path.basename(a) === "package.json")) {
      const j = await ctx.json(abs);
      if (j) manifestIdx.push({ dir: path.dirname(abs), name: j.name, scripts: j.scripts ?? {} });
    }
    return manifestIdx;
  };

  const problems = [];
  const findings = [];
  const problem = (lineNo, message) => {
    problems.push(`README:${lineNo} — ${message}`);
    findings.push(finding(message, "README.md", lineNo));
  };
  const npxMentions = [];
  let inFence = false;
  let fenceCwd = projectPath; // null = unknown (cd into something outside the repo/unresolvable)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      fenceCwd = projectPath;
      continue;
    }
    let cwd = inFence ? fenceCwd : projectPath;
    // Split on shell separators so `cd web && npm run dev` resolves `dev` in web/.
    for (const seg of line.split(/&&|\|\||;|\|/)) {
      const cd = seg.match(/^\s*`?(?:[$>]\s*)?cd\s+([^\s`]+)`?\s*$/);
      if (cd) {
        const target = cwd ? insideRoot(projectPath, cwd, cd[1].replace(/^["'`]|["'`]$/g, "")) : null;
        cwd = target && (await ctx.isDir(target)) ? target : null;
        if (inFence) fenceCwd = cwd;
        continue;
      }
      for (const m of seg.matchAll(/\bnpm\s+([^`\n]*)/g)) {
        const cmd = parseNpmRun(m[1]);
        if (!cmd) continue;
        const { script } = cmd;
        let base = cwd;
        if (cmd.prefix) base = insideRoot(projectPath, cwd ?? projectPath, cmd.prefix);
        if (!base) continue; // cwd unknown or escapes the repo — nothing checkable
        const targets = []; // { scripts, where } | { missing }
        if (cmd.allWorkspaces) {
          const found = (await manifests()).some((mf) => mf.dir !== projectPath && script in mf.scripts);
          if (!found && !cmd.ifPresent) problem(lineNo, `"npm run ${script} --workspaces" matches no workspace package.json script`);
          continue;
        }
        if (cmd.workspaces.length === 0) {
          const pkg = base === projectPath ? rootPkg : await ctx.json(path.join(base, "package.json"));
          if (!pkg) continue; // e.g. cd into a dir without a manifest — not checkable
          targets.push({ scripts: pkg.scripts ?? {}, where: base === projectPath ? "root package.json" : `${path.relative(projectPath, base)}/package.json` });
        } else {
          for (const ws of cmd.workspaces) {
            const dir = insideRoot(projectPath, base, ws);
            let pkg = dir ? await ctx.json(path.join(dir, "package.json")) : null;
            let where = `${ws}/package.json`;
            if (!pkg) {
              const byName = (await manifests()).find((mf) => mf.name === ws);
              if (byName) {
                pkg = { scripts: byName.scripts };
                where = `${path.relative(projectPath, byName.dir)}/package.json`;
              }
            }
            if (!pkg) {
              problem(lineNo, `"npm run ${script}" targets unknown workspace ${ws}`);
              continue;
            }
            targets.push({ scripts: pkg.scripts ?? {}, where });
          }
        }
        if (cmd.ifPresent) continue;
        for (const t of targets) {
          if (!(script in t.scripts)) problem(lineNo, `"npm run ${script}" has no such script in ${t.where}`);
        }
      }
      if (cwd) {
        for (const m of seg.matchAll(/(?<![.\w/])(\.\/scripts\/[\w./-]+)/g)) {
          const ref = m[1].replace(/[.,;:)]+$/, ""); // prose punctuation, not part of the path
          if (!(await ctx.exists(path.resolve(cwd, ref)))) problem(lineNo, `"${ref}" does not exist`);
        }
      }
      for (const m of seg.matchAll(/\bnpx\s+([@\w/.-]+)/g)) npxMentions.push(m[1]);
    }
  }
  if (problems.length > 0) return res("fail", cap(problems.join(" | ")), findings);
  const npxNote = npxMentions.length ? ` (${npxMentions.length} npx mention(s), informational)` : "";
  return res("pass", `every documented npm-run / scripts command resolves${npxNote}`);
}

const COMPOSE_NAME_RE = /^(docker-)?compose[^/]*\.ya?ml$/i;

async function composeFilesAtRoot(ctx) {
  return (await ctx.rootEntries()).filter((e) => e.isFile() && COMPOSE_NAME_RE.test(e.name)).map((e) => e.name);
}

/** Docker Compose auto-loads the project-dir `.env`. A stale one (leftover
 *  layout, `change-me` values) silently diverges from compose defaults and
 *  breaks fresh-volume first boot — the exact defect class that slipped past
 *  warm-container verification. Warning, not a gate: the file may be legit.
 *  Only meaningful when the project has a compose file at its root.
 */
async function checkComposeEnv(ctx) {
  const envPath = path.join(ctx.projectPath, ".env");
  if (!(await ctx.exists(envPath))) return res("pass", "no project-dir .env — compose runs on its own defaults");
  if ((await composeFilesAtRoot(ctx)).length === 0) return res("pass", "a project-dir .env exists but there is no compose file for it to be auto-loaded by");
  const text = (await ctx.text(envPath)) ?? "";
  const preview = text
    .split("\n")
    .filter((l) => /^[A-Za-z_]/.test(l) && !l.trim().startsWith("#"))
    .slice(0, 6)
    .map((l) => l.split("=")[0])
    .join(", ");
  const evidence = `a project-dir .env exists (keys: ${preview || "unreadable"}) — docker compose AUTO-LOADS it, so its values override image defaults on every fresh volume; a stale file breaks first boot while warm-container tests stay green. Confirm it is intentional and aligned, or delete it`;
  return res("warn", evidence, [finding("project-dir .env is auto-loaded by docker compose", ".env")]);
}

/** Unpinned/floating compose image tags drift silently (`:latest` re-pulls a
 *  different stack one day). Warning: major-minor pins are fine, `latest` and
 *  tag-less images are the finding.
 */
async function checkComposePins(ctx) {
  const composeFiles = await composeFilesAtRoot(ctx);
  if (composeFiles.length === 0) return res("skipped", "no compose files at the project root");
  const hits = [];
  for (const name of composeFiles) {
    const lines = await ctx.lines(path.join(ctx.projectPath, name));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/#.*$/, ""); // strip comments
      const m = line.match(/\bimage:\s*['"]?([^\s'"]+)/); // block AND inline flow style
      if (!m) continue;
      const ref = m[1].replace(/[,}]+$/, "");
      if (ref.includes("$")) continue; // variable-substituted — unresolvable here
      if (ref.includes("@sha256:")) continue; // digest pin
      // a tag is a colon AFTER the last slash (registry:port/img has a colon in the host part)
      const tag = ref.slice(ref.lastIndexOf("/") + 1).split(":").slice(1).join(":");
      if (tag === "latest" || (!tag && !ref.startsWith("./"))) hits.push({ name, line: i + 1, ref });
    }
  }
  if (hits.length > 0) {
    return res(
      "warn",
      cap(`floating image references (pin exact or major.minor tags — ':latest' re-pulls a different stack one day): ${hits.map((h) => `${h.name}:${h.line} → ${h.ref}`).join("; ")}`),
      hits.map((h) => finding(`floating image reference ${h.ref}`, h.name, h.line)),
    );
  }
  return res("pass", `all image references pinned across ${composeFiles.length} compose file(s)`);
}

// ------------------------------------------------------------------ entry ---

/** The check table. `level` is the default; NANO_CHECKS_ADVISORY / opts.levels override. */
export const CHECK_DEFS = [
  { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", level: "gating", run: checkSecrets },
  { id: "deps-declared", title: "Dependency declarations", level: "gating", run: checkDepsDeclared },
  { id: "no-cdn-fonts", title: "Local font loading (no font CDN)", level: "gating", run: checkNoCdnFonts },
  { id: "i18n-parity", title: "Locale key parity", level: "gating", run: checkI18nParity },
  { id: "env-wiring", title: "Env template wiring", level: "gating", run: checkEnvWiring },
  { id: "readme-commands", title: "README command truth", level: "gating", run: checkReadmeCommands },
  { id: "compose-env", title: "Compose auto-loaded .env", level: "advisory", run: checkComposeEnv },
  { id: "compose-pins", title: "Compose image pins", level: "advisory", run: checkComposePins },
];

function disabledChecks() {
  const v = (process.env.NANO_CHECKS ?? "").trim().toLowerCase();
  if (!v) return null; // all enabled
  if (v === "off" || v === "none" || v === "false") return "all";
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

function advisoryOverride() {
  const v = (process.env.NANO_CHECKS_ADVISORY ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "all") return "all";
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Effective level for a check: opts.levels[id] > NANO_CHECKS_ADVISORY > table default. */
export function checkLevel(id, levels) {
  const def = CHECK_DEFS.find((d) => d.id === id);
  const explicit = levels?.[id];
  if (explicit === "gating" || explicit === "advisory") return explicit;
  const adv = advisoryOverride();
  if (adv === "all" || adv?.has(id)) return "advisory";
  return def?.level ?? "gating";
}

function perCheckTimeoutMs(opts) {
  const n = Number(opts.timeoutMs ?? process.env.NANO_CHECK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}

async function runOne(def, shared, opts) {
  const base = { id: def.id, title: def.title };
  const level = checkLevel(def.id, opts.levels);
  const out = (status, evidence, findings = [], extra = {}) => ({ ...base, level, status, evidence, findings, ...extra });
  const disabled = disabledChecks();
  if (disabled === "all" || disabled?.has(def.id)) return out("skipped", "disabled via NANO_CHECKS");
  const timeoutMs = perCheckTimeoutMs(opts);
  // A ref'd timer (not AbortSignal.timeout, which is unref'd): the timeout must
  // fire even when nothing else keeps the process alive.
  const timer = new AbortController();
  const timeoutHandle = setTimeout(() => timer.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), timer.signal]);
  if (signal.aborted) {
    clearTimeout(timeoutHandle);
    return out("skipped", "aborted before start");
  }
  const aborted = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  aborted.catch(() => {});
  try {
    const r = await Promise.race([def.run(makeCtx(shared, signal)), aborted]);
    const status = ["pass", "warn", "fail", "skipped"].includes(r?.status) ? r.status : "skipped";
    const evidence = String(r?.evidence ?? "");
    const findings = Array.isArray(r?.findings) ? r.findings : [];
    if (status === "fail" && level === "advisory") {
      return out("warn", cap(`(advisory — not gating) ${evidence}`), findings, { rawStatus: "fail" });
    }
    return out(status, evidence, findings);
  } catch (e) {
    if (signal.aborted) {
      const timedOut = !opts.signal?.aborted;
      return out("skipped", timedOut ? `${def.id}: timed out after ${timeoutMs}ms` : `${def.id}: aborted`);
    }
    return out("skipped", `check error: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Run all mechanical checks. Never throws; each check returns
 *  { id, title, level, status: "pass"|"warn"|"fail"|"skipped", evidence, findings[] }.
 *  Only a gating "fail" gates; "warn" (incl. advisory failures) is recorded for
 *  the owner without a fix round; "skipped" (incl. timeout/abort) never gates.
 *  Extra opts (all optional, backward compatible): signal (AbortSignal),
 *  timeoutMs, levels ({id: "gating"|"advisory"}), only ([ids]), exec (test seam). */
export async function runMechanicalChecks({ projectPath, runId, emit, signal, timeoutMs, levels, only, exec } = {}) {
  void runId;
  void emit; // reserved for per-check progress if ever needed
  const opts = { signal, timeoutMs, levels };
  const shared = makeShared(projectPath, signal, exec);
  const defs = only ? CHECK_DEFS.filter((d) => only.includes(d.id)) : CHECK_DEFS;
  return Promise.all(defs.map((d) => runOne(d, shared, opts)));
}
