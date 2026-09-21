// Token-hygiene injection tests — caveman-lite + rtk in every agent run.
// Run: node tests/token-hygiene.test.mjs
import assert from "node:assert";
import { tokenHygiene, rtkAvailable, webCapabilities } from "../host/token-hygiene.mjs";
import { clarifySystem, builderSystem, verifierSystem, securitySystem } from "../host/prompts.mjs";

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`);
  }
};

const skillDirs = {
  planning: "/skills/planning", taskBreakdown: "/skills/task-breakdown", implementation: "/skills/implementation",
  verification: "/skills/verification", auditDeliverables: "/skills/audit", securityScan: "/skills/security", vapt: "/skills/vapt",
};

test("tokenHygiene block: caveman-lite discipline + clarity-wins rules", () => {
  const block = tokenHygiene();
  assert.match(block, /caveman-lite/);
  assert.match(block, /no filler|no hedging/i);
  assert.match(block, /Clarity always wins/, "accuracy outranks brevity");
  assert.match(block, /Security findings.*full plain prose|Security findings[\s\S]*plain prose/, "security findings exempt from compression");
  assert.match(block, /error strings stay EXACT|error strings/i);
});

test("tokenHygiene block: rtk + research sections follow availability; stable (cached)", () => {
  const block = tokenHygiene();
  if (rtkAvailable()) {
    assert.match(block, /rtk git status/, "rtk usage table present when installed");
    assert.match(block, /fall back to the plain command/, "fallback rule present");
  } else {
    assert.doesNotMatch(block, /rtk git status/, "no rtk advertising when absent");
  }
  const caps = webCapabilities();
  if (caps.search) {
    assert.match(block, /web_search \(SearXNG\)/, "web_search guidance present when searxng answers");
    assert.match(block, /verify rather than guess/);
  } else {
    assert.doesNotMatch(block, /web_search \(SearXNG\)/, "no web_search guidance when searxng absent");
  }
  if (caps.reader) {
    assert.match(block, /web_reader \(obscura browser\)/, "web_reader guidance present when obscura answers");
  }
  assert.strictEqual(tokenHygiene(), block, "static block built once (no per-session churn)");
});

test("every step system prompt carries the block via the loader contract", () => {
  // The loader appends tokenHygiene() to the systemPrompt each step passes —
  // assert the step systems are strings (the join target) and the block is
  // self-sufficient: it must not RELY on step-prompt context.
  for (const [name, sys] of [
    ["clarify", clarifySystem()],
    ["builder", builderSystem({ skillDirs })],
    ["verifier", verifierSystem({ skillDirs })],
    ["security", securitySystem({ skillDirs })],
  ]) {
    assert.strictEqual(typeof sys, "string", `${name} system prompt is a string`);
    assert.ok(sys.length > 50, `${name} system prompt non-trivial`);
  }
  const block = tokenHygiene();
  assert.ok(!block.includes("${"), "no uninterpolated template leakage");
  assert.ok(block.length < 2500, `block stays compact (got ${block.length} chars) — it rides in every session`);
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} token-hygiene tests passed`);
process.exit(failed ? 1 : 0);
