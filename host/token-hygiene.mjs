// Token hygiene — injected into EVERY agent run's system prompt (pipeline
// steps, clarify/analyst/coder children, chat sessions). Two parts:
//
//   caveman-lite — output discipline from JuliusBrussee/caveman (adapted):
//   terse, no filler, technical accuracy sacred, clarity wins on conflict.
//
//   rtk — the Rust Token Killer CLI (token-optimized proxies for read-only
//   dev commands: git/ls/find/test/json/…). Only advertised when installed.
//
//   research tools — web_search (SearXNG) + web_reader (obscura browser), with
//   WHEN-to-use guidance; sections appear only for tools that answer at boot.
//
// Injection points: runner.mjs buildLoader (systemPromptOverride — covers
// every engine session) and chat.mjs (appendSystemPrompt — keeps pi's default
// prompt). Milestones/artifacts are structured tool calls: style never
// touches machine-parsed output.
import { spawnSync } from "node:child_process";
import { detectWebCapabilities } from "./webtools.mjs";

// The deploy-standard SearXNG endpoint (scripts/deploy.sh installs it here);
// overridden by NANO_SEARXNG_URL — must match server.mjs.
const SEARXNG_URL = process.env.NANO_SEARXNG_URL ?? "http://127.0.0.1:8888";

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

let capsChecked = undefined;

/** Web research capabilities, probed once per process (shared with server.mjs).
 *  One retry on a failed search probe — an idle searxng occasionally answers
 *  past the first curl's timeout. */
export function webCapabilities() {
  if (capsChecked === undefined) {
    try {
      capsChecked = detectWebCapabilities(process.env.NANO_SEARXNG_URL ?? SEARXNG_URL);
      if (!capsChecked.search) {
        const retry = detectWebCapabilities(process.env.NANO_SEARXNG_URL ?? SEARXNG_URL);
        if (retry.search) capsChecked = { ...capsChecked, search: true };
      }
    } catch {
      capsChecked = { search: false, reader: false };
    }
  }
  return capsChecked;
}

// The block is static per availability — build once.
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
  const caps = webCapabilities();
  if (caps.search || caps.reader) {
    const lines = [];
    if (caps.search) {
      lines.push(
        `- web_search (SearXNG): during investigation and planning, check unfamiliar APIs, library versions, and design options BEFORE deciding or coding — verify rather than guess from memory. Note what you found and from where.`,
      );
    }
    if (caps.reader) {
      lines.push(
        `- web_reader (obscura browser): when a search snippet is not enough, LOAD the actual page — it renders JavaScript, so docs, changelogs, and app pages read as real content. Also use it to confirm a URL behaves as claimed. Never speculate about a page's contents from its URL alone.`,
      );
    }
    parts.push(
      `## Research tools (read-only — use when they reduce uncertainty)

${lines.join("\n")}
Prefer local evidence first (the repo, running code); reach for the web when the repo cannot answer. Don't browse for its own sake.`,
    );
  }
  cached = parts.join("\n\n");
  return cached;
}
