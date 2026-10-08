// Pure GUI logic (web/src/lib) — node:test, no browser. Run: node tests/web-lib.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, capAppend, canRedirectToLogin } from "../web/src/lib/backoff.ts";
import { buildBlocks, filterBlocks, countByNode } from "../web/src/lib/console-blocks.ts";
import { changedPatch, fieldsOf, mergeExternal } from "../web/src/lib/ticket-edit.ts";

test("backoffDelay grows exponentially with jitter and caps at 30s", () => {
  const hi = () => 0.999999;
  const lo = () => 0;
  assert.equal(backoffDelay(0, lo), 250);
  assert.equal(backoffDelay(0, hi), 500);
  assert.equal(backoffDelay(3, hi), 4000);
  assert.equal(backoffDelay(30, hi), 30000);
  assert.equal(backoffDelay(30, lo), 15000);
  for (let a = 0; a < 12; a++) assert.ok(backoffDelay(a) <= 30000);
});

test("capAppend keeps the newest `cap` items and returns prev when nothing arrives", () => {
  const prev = [1, 2, 3];
  assert.equal(capAppend(prev, [], 5), prev);
  assert.deepEqual(capAppend(prev, [4, 5], 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(capAppend(prev, [4, 5, 6], 5), [2, 3, 4, 5, 6]);
  assert.deepEqual(capAppend([], [1, 2, 3, 4, 5, 6, 7], 3), [5, 6, 7]);
  assert.deepEqual(prev, [1, 2, 3], "input not mutated");
});

test("login redirect loop guard allows one redirect per window", () => {
  assert.equal(canRedirectToLogin(null, 1000), true);
  assert.equal(canRedirectToLogin(NaN, 1000), true);
  assert.equal(canRedirectToLogin(1000, 5000), false);
  assert.equal(canRedirectToLogin(1000, 17000), true);
});

const ev = (nodeId, ts, t, extra = {}) => ({ ts, nodeId, ev: { t, ...extra } });

test("buildBlocks coalesces streamed bursts per node+type; discrete events close them", () => {
  const events = [
    ev("build", 1, "think", { s: "a" }),
    ev("build", 2, "think", { s: "b" }),
    ev("build", 3, "tool", { name: "read", args: "{}" }),
    ev("build", 4, "think", { s: "c" }),
    ev("verify", 5, "text", { s: "x" }),
    ev("build", 6, "think", { s: "d" }),
  ];
  const blocks = buildBlocks(events, null);
  assert.deepEqual(blocks.map((b) => [b.t, b.text, b.count]), [
    ["think", "ab", 2],
    ["tool", "", 1],
    ["think", "cd", 2],
    ["text", "x", 1],
  ]);
  assert.deepEqual(buildBlocks(events, "verify").map((b) => b.text), ["x"]);
});

test("buildBlocks keys are positional-independent and unique for same-ms twins", () => {
  const twins = [ev("n", 7, "tool", { name: "read", args: "a" }), ev("n", 7, "tool", { name: "read", args: "b" })];
  const keys = buildBlocks(twins, null).map((b) => b.key);
  assert.equal(new Set(keys).size, 2);
  // dropping an older event (buffer rotation) must not change a surviving block's key
  const more = [ev("n", 1, "usage", { usage: { input: 1 } }), ...twins];
  assert.deepEqual(buildBlocks(more, null).slice(1).map((b) => b.key), keys);
});

test("filterBlocks + countByNode", () => {
  const blocks = buildBlocks(
    [ev("a", 1, "tool_end", { ok: false, name: "bash" }), ev("a", 2, "text", { s: "Hello World" }), ev("b", 3, "notice", { s: "heads up" })],
    null,
  );
  assert.equal(filterBlocks(blocks, "errors", "").length, 2);
  assert.equal(filterBlocks(blocks, "all", "hello").length, 1);
  assert.equal(filterBlocks(blocks, "text", "nomatch").length, 0);
  assert.deepEqual([...countByNode([ev("a", 1, "x"), ev("a", 2, "x"), ev("b", 3, "x")])], [["a", 2], ["b", 1]]);
});

const T = (o = {}) => ({ title: "T", description: "D", dependsOn: ["F1", "F2"], order: 3, ...o });

test("changedPatch sends only the fields the user edited", () => {
  const base = fieldsOf(T());
  assert.deepEqual(changedPatch(base, { ...base }), {});
  assert.deepEqual(changedPatch(base, { ...base, title: "New" }), { title: "New" });
  assert.deepEqual(changedPatch(base, { ...base, dependsOn: "F1,F2" }), {}, "whitespace-only dependsOn change is not a change");
  assert.deepEqual(changedPatch(base, { ...base, dependsOn: "F1" , order: "5" }), { dependsOn: ["F1"], order: 5 });
});

test("mergeExternal: untouched fields follow the server, edited fields keep the draft and flag conflicts", () => {
  const base = fieldsOf(T());
  const draft = { ...base, title: "My title" };
  const server = fieldsOf(T({ description: "Server desc", title: "Server title" }));
  const m = mergeExternal(base, draft, server);
  assert.equal(m.draft.description, "Server desc", "untouched field adopts server value");
  assert.equal(m.draft.title, "My title", "edited field keeps user text");
  assert.deepEqual(m.conflicts, ["title"]);
  // Save now sends only the title; the server's description is NOT overwritten.
  assert.deepEqual(changedPatch(m.base, m.draft), { title: "My title" });
});

test("mergeExternal: no server movement is a no-op; converging edits are not conflicts", () => {
  const base = fieldsOf(T());
  const draft = { ...base, title: "X" };
  const same = mergeExternal(base, draft, base);
  assert.deepEqual(same, { base, draft, conflicts: [] });
  const conv = mergeExternal(base, draft, fieldsOf(T({ title: "X" })));
  assert.deepEqual(conv.conflicts, []);
  assert.deepEqual(changedPatch(conv.base, conv.draft), {});
});
