// Per-project, per-STEP context resolution. A project teaches nano-cycle about
// itself through conventional files, all optional, resolved from EVERY
// conventional location:
//
//   <project>/AGENTS.md or CLAUDE.md  (root, else .pi/AGENTS.md)  → EVERY step
//   <project>/.claude/rules/<name>.md  or  .pi/rules/<name>.md    → per step below
//
//   backend-development-rules.md, security-rules.md, frontend-development-rules.md,
//   testing-rules.md, git-guidelines.md → build (one context now — the lane split
//   is gone) AND verify; security-rules.md → security
//
// Precedence per filename: .claude/ wins over .pi/ — a project migrating
// toolchains keeps one source of truth. Projects with none of these run with
// the built-in minimal rules only — nano-cycle stays stack-agnostic.
import fs from "node:fs";
import path from "node:path";

const PER_FILE_CAP = 20_000;

// Conventional rules directories, highest precedence first.
const RULE_DIRS = [".claude/rules", ".pi/rules"];

/** First existing match for a rules filename across conventional dirs. */
function resolveRuleFile(projectPath, filename) {
  for (const dir of RULE_DIRS) {
    const p = path.join(projectPath, dir, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The build step is ONE context now — the lane split is gone, so the builder
// (and its dispatch_coder children) sees every rule file. Verify likewise.
// Security gets the security contract; clarify stays AGENTS-only.
const STEP_RULES = {
  clarify: [],
  build: [
    "backend-development-rules.md",
    "security-rules.md",
    "frontend-development-rules.md",
    "testing-rules.md",
    "git-guidelines.md",
  ],
  verify: [
    "testing-rules.md",
    "backend-development-rules.md",
    "security-rules.md",
    "frontend-development-rules.md",
    "git-guidelines.md",
  ],
  security: ["security-rules.md"],
};

/** Context files for one v2 step (AGENTS/CLAUDE + the step's rule files). */
export function stepContextFiles(projectPath, stepId) {
  const out = [];
  for (const candidate of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(projectPath, candidate);
    if (fs.existsSync(p)) {
      out.push({ name: candidate, path: p });
      break;
    }
  }
  if (out.length === 0) {
    const p = path.join(projectPath, ".pi", "AGENTS.md");
    if (fs.existsSync(p)) out.push({ name: ".pi/AGENTS.md", path: p });
  }
  for (const f of STEP_RULES[stepId] ?? []) {
    const p = resolveRuleFile(projectPath, f);
    if (p) out.push({ name: f, path: p });
  }
  return out;
}

/** Load and assemble the context block for a v2 step's system prompt. */
export function loadStepContext(projectPath, stepId, onFile) {
  const parts = [];
  for (const f of stepContextFiles(projectPath, stepId)) {
    let content = fs.readFileSync(f.path, "utf8");
    const size = content.length;
    if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + "\n\n(truncated)";
    parts.push(`# ${f.name}\n\n${content.trim()}`);
    onFile?.({ name: f.name, chars: size });
  }
  return parts.join("\n\n");
}
