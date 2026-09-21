// Token hygiene — injected into EVERY agent run's system prompt (pipeline
// steps, clarify/analyst/coder children, chat sessions). Two parts:
//
//   caveman-lite — output discipline from JuliusBrussee/caveman (adapted):
//   terse, no filler, technical accuracy sacred, clarity wins on conflict.
//
//   rtk — the Rust Token Killer CLI (token-optimized proxies for read-only
//   dev commands: git/ls/find/test/json/…). Only advertised when installed.
//
// Injection points: runner.mjs buildLoader (systemPromptOverride — covers
// every engine session) and chat.mjs (appendSystemPrompt — keeps pi's default
// prompt). Milestones/artifacts are structured tool calls: style never
// touches machine-parsed output.
import { spawnSync } from "node:child_process";

let rtkChecked = undefined;

/** True when the rtk CLI is on PATH (checked once per process). */
export function rtkAvailable() {
  if (rtkChecked === undefined) {
    try {
      rtkChecked = spawnSync("rtk", ["--version"], { timeout: 5_000, encoding: "utf8" }).status === 0;
    } catch {
      rtkChecked = false;
    }
  }
  return rtkChecked;
}

// The block is static per rtk availability — build once.
let cached = null;

/** The system-prompt block. Compact by design: it rides in every session. */
export function tokenHygiene() {
  if (cached) return cached;
  const parts = [
    `## Output discipline (caveman-lite)

Respond terse: no filler, no hedging, no pleasantries, no restating the task. Short sentences, one idea each, active voice. Standard acronyms OK; never invent abbreviations. Technical terms, code, API names, commands, and error strings stay EXACT and verbatim. Numbers and units exact.

Tool calls: fire direct — no preamble, plan, or progress notes before or between calls; after a result, go straight to the next call or the final answer.

Clarity always wins: never drop not/never/no/only/except; never trade accuracy for brevity. Security findings, warnings about irreversible actions, and anything the owner must decide stay in full plain prose.

Final summaries: lead with what changed and the verification evidence. Skip narrating what you were about to do.`,
  ];
  if (rtkAvailable()) {
    parts.push(
      `## rtk — token-optimized command proxy

The rtk CLI filters verbose command output before it reaches your context. Prefer it for READ-ONLY, output-heavy commands: \`rtk git status\`, \`rtk git diff\`, \`rtk git log\`, \`rtk ls\`, \`rtk find\`, \`rtk test <cmd>\` (failures only), \`rtk err <cmd>\` (errors only), \`rtk json\`, \`rtk deps\`, \`rtk tree\`. Run state-changing or interactive commands plain (\`git commit/push/checkout\`, installs, anything needing stdin). If rtk is missing or errors, fall back to the plain command without comment.`,
    );
  }
  cached = parts.join("\n\n");
  return cached;
}
