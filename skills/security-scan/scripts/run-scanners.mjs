#!/usr/bin/env node
// Deterministic security scanner suite — driver-side ground truth for the
// security step. Standalone (no host imports) so the skill can mandate it and
// the engine can spawn it directly:
//
//   node skills/security-scan/scripts/run-scanners.mjs <project-dir>
//
// Scanners (each degrades to a recorded skip — skips never gate):
//   secrets-gitleaks : gitleaks binary → pinned docker → skip
//   deps-audit       : npm|pnpm|yarn audit --json (by lockfile) → skip if none
//   static-semgrep   : semgrep --config auto (binary only) → skip
//   image-trivy      : trivy config scan on compose files (binary only) → skip
//
// Output: single JSON object on stdout:
//   { scanners: [{ id, title, status: "pass"|"fail"|"skip", evidence, findings? }] }
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
if (!fs.existsSync(dir)) {
  console.error(`usage: run-scanners.mjs <project-dir> (got: ${dir})`);
  process.exit(2);
}

const cap = (s, n = 600) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function sh(bin, args, timeoutMs) {
  const r = spawnSync(bin, args, { cwd: dir, timeout: timeoutMs ?? 120_000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return r;
}

// --- secrets-gitleaks ----------------------------------------------------------
function gitleaks() {
  // Report goes to a FILE (docker's /dev/stdout write vanishes — file-open on a pipe)
  const reportFile = `.gitleaks-report-${process.pid}.json`;
  const clean = () => { try { fs.rmSync(path.join(dir, reportFile), { force: true }); } catch { /* */ } };
  const argsFor = (source, reportPath) => ["detect", "--source", source, "--no-git", "--report-format", "json", "--report-path", reportPath, "--redact"];
  let stdout = "";
  let mode = "";
  let exitOne = false;
  const r = sh("gitleaks", argsFor(".", path.join(dir, reportFile)));
  if (r.error?.code === "ENOENT" || r.status === 127) {
    const image = process.env.NANO_GITLEAKS_IMAGE ?? "zricethezav/gitleaks:v8.24.3";
    const d = sh("docker", ["run", "--rm", "-v", `${dir}:/src`, image, ...argsFor("/src", `/src/${reportFile}`)]);
    if (d.error?.code === "ENOENT" || d.status === 127) {
      return { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", status: "skip", evidence: "gitleaks and docker unavailable" };
    }
    if (d.status === 1) exitOne = true;
    stdout = d.stdout ?? "";
    mode = `docker ${image}`;
  } else {
    if (r.status === 1) exitOne = true;
    stdout = r.stdout ?? "";
    mode = "gitleaks binary";
  }
  try {
    stdout = fs.readFileSync(path.join(dir, reportFile), "utf8");
  } catch {
    /* report file unreadable — fall through to exit-code truth */
  } finally {
    clean();
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
    return { id: "secrets-gitleaks", title: "Secrets scan (gitleaks)", status: "fail", evidence: `gitleaks exit 1 (findings) via ${mode}; report unparseable` };
  }
  return {
    id: "secrets-gitleaks",
    title: "Secrets scan (gitleaks)",
    status: "fail",
    evidence: cap(`${findings.length} finding(s) via ${mode}: ${findings.slice(0, 5).map((f) => `${f.File}:${f.StartLine} (${f.RuleID})`).join("; ")}`),
    findings: findings.slice(0, 20).map((f, i) => ({
      id: `gitleaks-${i + 1}`,
      source: "scanner",
      severity: "critical",
      title: `Possible secret: ${f.RuleID ?? "rule"}`,
      evidence: `${String(f.File ?? "").replace(/^\/src\//, "")}:${f.StartLine} — ${cap(f.Description ?? f.Match ?? "", 200)}`,
      file: `${String(f.File ?? "").replace(/^\/src\//, "")}:${f.StartLine}`,
      fix: "Remove the secret; rotate the credential; use env/secret management",
      fixable_in_scope: true,
    })),
  };
}

// --- deps-audit ------------------------------------------------------------------
function depAudit() {
  const manifest =
    fs.existsSync(path.join(dir, "package-lock.json")) ? { bin: "npm", args: ["audit", "--json"] } :
    fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ? { bin: "pnpm", args: ["audit", "--json"] } :
    fs.existsSync(path.join(dir, "yarn.lock")) ? { bin: "yarn", args: ["npm", "audit", "--json"] } :
    null;
  if (!manifest) return { id: "deps-audit", title: "Dependency audit", status: "skip", evidence: "no recognized lockfile (npm/pnpm/yarn)" };
  const r = sh(manifest.bin, manifest.args, 180_000);
  if (r.error?.code === "ENOENT" || r.status === 127) {
    return { id: "deps-audit", title: "Dependency audit", status: "skip", evidence: `${manifest.bin} not on PATH` };
  }
  let report = null;
  try {
    // npm/pnpm can print non-JSON warnings before the JSON body — take the last JSON-looking chunk
    const txt = r.stdout ?? "";
    const start = txt.indexOf("{");
    report = JSON.parse(txt.slice(start >= 0 ? start : 0));
  } catch {
    return { id: "deps-audit", title: "Dependency audit", status: "skip", evidence: `unparseable ${manifest.bin} audit output` };
  }
  const vulns = report?.vulnerabilities ?? {};
  const entries = Object.values(vulns);
  const sev = (v) => v?.severity ?? "unknown";
  const counts = {};
  for (const v of entries) counts[sev(v)] = (counts[sev(v)] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${s}:${n}`).join(" ") || "none";
  const blocking = entries.filter((v) => ["critical", "high"].includes(sev(v)));
  if (blocking.length === 0) {
    return { id: "deps-audit", title: "Dependency audit", status: "pass", evidence: `${manifest.bin} audit clean (${summary})` };
  }
  return {
    id: "deps-audit",
    title: "Dependency audit",
    status: "fail",
    evidence: cap(`${blocking.length} critical/high vulnerability(ies) (${summary}): ${blocking.slice(0, 5).map((v) => `${v.name} (${sev(v)}${v.fixAvailable === false ? ", no fix available" : ""}) via ${String(v.via?.[0]?.title ?? v.via?.[0] ?? "?").slice(0, 60)}`).join("; ")}`),
    findings: blocking.slice(0, 20).map((v, i) => ({
      id: `audit-${i + 1}`,
      source: "scanner",
      severity: sev(v) === "critical" ? "critical" : "high",
      title: `Vulnerable dependency: ${v.name}@${v.range ?? "?"}`,
      evidence: `${v.name}: ${sev(v)} — via ${cap(JSON.stringify(v.via?.[0]?.title ?? v.via?.[0] ?? "?"), 140)}; fixAvailable: ${JSON.stringify(v.fixAvailable)}`,
      file: "package.json",
      fix: v.fixAvailable ? `Update ${v.name} (fix available)` : `No fix available yet — owner decision`,
      fixable_in_scope: v.fixAvailable ? true : false,
    })),
  };
}

// --- static-semgrep ----------------------------------------------------------------
function semgrep() {
  const r = sh("semgrep", ["--config", "auto", "--json", "--quiet"], 300_000);
  if (r.error?.code === "ENOENT" || r.status === 127) {
    return { id: "static-semgrep", title: "Static analysis (semgrep)", status: "skip", evidence: "semgrep not on PATH" };
  }
  let report = null;
  try {
    report = JSON.parse(r.stdout ?? "");
  } catch {
    return { id: "static-semgrep", title: "Static analysis (semgrep)", status: "skip", evidence: "unparseable semgrep output" };
  }
  const results = report?.results ?? [];
  if (results.length === 0) {
    return { id: "static-semgrep", title: "Static analysis (semgrep)", status: "pass", evidence: `no findings (semgrep auto)` };
  }
  return {
    id: "static-semgrep",
    title: "Static analysis (semgrep)",
    status: "pass", // informational by default — the model triages severity
    evidence: `${results.length} finding(s) (auto ruleset) — triage below`,
    findings: results.slice(0, 30).map((f, i) => ({
      id: `semgrep-${i + 1}`,
      source: "scanner",
      severity: "medium",
      title: `${f.check_id ?? "semgrep"} in ${path.basename(f.path ?? "?")}`,
      evidence: `${f.path}:${f.start?.line} — ${cap(f.extra?.message ?? "", 160)}`,
      file: `${f.path}:${f.start?.line}`,
      fix: cap(f.extra?.fix ?? "", 160) || "Review and remediate",
      fixable_in_scope: true,
    })),
  };
}

// --- image-trivy --------------------------------------------------------------------
function trivy() {
  const composeFiles = fs.readdirSync(dir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
  if (composeFiles.length === 0) {
    return { id: "image-trivy", title: "Container config scan (trivy)", status: "skip", evidence: "no docker-compose file at project root" };
  }
  const r = sh("trivy", ["config", "--format", "json", ...composeFiles], 240_000);
  if (r.error?.code === "ENOENT" || r.status === 127) {
    return { id: "image-trivy", title: "Container config scan (trivy)", status: "skip", evidence: "trivy not on PATH" };
  }
  let report = null;
  try {
    report = JSON.parse(r.stdout ?? "");
  } catch {
    return { id: "image-trivy", title: "Container config scan (trivy)", status: "skip", evidence: "unparseable trivy output" };
  }
  const misconfigurations = report?.Results?.flatMap((x) => x.Misconfigurations ?? []) ?? [];
  const fails = misconfigurations.filter((m) => m.Status === "FAIL");
  if (fails.length === 0) {
    return { id: "image-trivy", title: "Container config scan (trivy)", status: "pass", evidence: `no config misconfigurations (${composeFiles.join(", ")})` };
  }
  return {
    id: "image-trivy",
    title: "Container config scan (trivy)",
    status: "fail",
    evidence: cap(`${fails.length} misconfiguration(s): ${fails.slice(0, 5).map((m) => m.ID).join("; ")}`),
    findings: fails.slice(0, 20).map((m, i) => ({
      id: `trivy-${i + 1}`,
      source: "scanner",
      severity: (m.Severity ?? "MEDIUM").toLowerCase().startsWith("c") || (m.Severity ?? "").toUpperCase() === "CRITICAL" ? "critical" : (m.Severity ?? "MEDIUM").toLowerCase().startsWith("h") ? "high" : "medium",
      title: `Container misconfiguration: ${m.ID}`,
      evidence: cap(`${m.Title ?? m.ID} — ${m.Description ?? ""}`, 200),
      file: m.PrimaryURL ? m.PrimaryURL : composeFiles[0],
      fix: cap(m.Resolution ?? "", 160) || "Review trivy advisory",
      fixable_in_scope: true,
    })),
  };
}

const scanners = [gitleaks(), depAudit(), semgrep(), trivy()];
const failed = scanners.filter((s) => s.status === "fail").length;
console.log(JSON.stringify({ scanners, summary: { fail: failed, pass: scanners.filter((s) => s.status === "pass").length, skip: scanners.filter((s) => s.status === "skip").length } }, null, 2));
process.exit(failed > 0 ? 1 : 0);
