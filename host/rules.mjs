// Per-project, per-node context resolution — the generic replacement for
// hard-coded rule paths. A project teaches nano-cycle about itself through
// conventional files, all optional:
//
//   <project>/AGENTS.md or CLAUDE.md                       → injected into EVERY node
//   <project>/.claude/rules/backend-development-rules.md   → implement-be (+security)
//   <project>/.claude/rules/security-rules.md              → implement-be
//   <project>/.claude/rules/frontend-development-rules.md  → implement-fe
//   <project>/.claude/rules/testing-rules.md               → implement nodes AND verify/audit
//   <project>/.claude/rules/git-guidelines.md              → implement nodes AND verify/audit
//
// Projects with none of these run with the built-in minimal rules only —
// nano-cycle stays language- and stack-agnostic by default.
import fs from "node:fs";
import path from "node:path";

const STACK_RULES = {
  "implement-be": ["backend-development-rules.md", "security-rules.md"],
  "implement-fe": ["frontend-development-rules.md"],
  // Verify and audit check BOTH sides against the repo's locked decisions —
  // they receive every rule file, not just the testing rules.
  verify: [
    "testing-rules.md",
    "backend-development-rules.md",
    "security-rules.md",
    "frontend-development-rules.md",
    "git-guidelines.md",
  ],
  audit: [
    "testing-rules.md",
    "backend-development-rules.md",
    "security-rules.md",
    "frontend-development-rules.md",
    "git-guidelines.md",
  ],
};

const PER_FILE_CAP = 20_000;

/** Rule files for a node — matched by lane suffix so capability-derived coder
 *  nodes (impl-<cap>-be / impl-<cap>-fe) get their side's rules too. */
export function stackRulesFor(nodeId) {
  if (nodeId === "verify" || nodeId === "audit") return [...STACK_RULES.verify];
  const out = [];
  if (nodeId === "implement" || nodeId.endsWith("-be")) {
    out.push("backend-development-rules.md", "security-rules.md");
  }
  if (nodeId === "implement" || nodeId.endsWith("-fe")) {
    out.push("frontend-development-rules.md");
  }
  // The testing contract reaches coders, not just the gates ("every behavior
  // ships tested", DB-never-mocked, …), and git conventions too (coders may
  // run git via bash even when the driver's git integration is off).
  out.push("testing-rules.md", "git-guidelines.md");
  return out;
}

/** Resolve the context files for one node in one project (existing files only). */
export function nodeContextFiles(projectPath, nodeId) {
  const out = [];
  for (const candidate of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(projectPath, candidate);
    if (fs.existsSync(p)) {
      out.push({ name: candidate, path: p });
      break; // first match wins — they are conventions for the same thing
    }
  }
  for (const f of stackRulesFor(nodeId)) {
    const p = path.join(projectPath, ".claude", "rules", f);
    if (fs.existsSync(p)) out.push({ name: f, path: p });
  }
  return out;
}

/** Load and assemble the context block for a node's system prompt. */
export function loadContext(projectPath, nodeId, onFile) {
  const parts = [];
  for (const f of nodeContextFiles(projectPath, nodeId)) {
    let content = fs.readFileSync(f.path, "utf8");
    const size = content.length;
    if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + "\n\n(truncated)";
    parts.push(`# ${f.name}\n\n${content.trim()}`);
    onFile?.({ name: f.name, chars: size });
  }
  return parts.join("\n\n");
}
