// Backlog parser + status flip unit tests — TODO 6. Run: node tests/backlog.test.mjs
import assert from "node:assert";
import { parseFeaturesMarkdown, importFromFile, flipStatus } from "../host/backlog.mjs";
import fs from "node:fs";
import path from "node:path";

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`); }
};

const DOC = `# Features

Some intro prose that must be ignored.

## F01 — Monorepo scaffold 🔴

I need a monorepo with npm workspaces.

Done when: one command brings the stack up.

### F02: Sign-in flow

Build the sign-in page. Business rules:
- EN + BN day one

## F03 Legacy import ✅

Already delivered elsewhere.

## Changelog

This heading has no feature id and ends F03's body.
`;

test("parse: three tickets, ids/titles/descriptions, intro ignored", () => {
  const t = parseFeaturesMarkdown(DOC);
  assert.strictEqual(t.length, 3);
  assert.deepStrictEqual(t.map((x) => x.id), ["F01", "F02", "F03"]);
  assert.match(t[0].title, /Monorepo scaffold/);
  assert.ok(t[0].description.includes("npm workspaces"));
  assert.ok(t[0].description.includes("Done when: one command brings the stack up"));
  assert.ok(!t[0].description.includes("intro prose"));
});

test("parse: status markers — 🔴 open, ✅ done, stripped from text", () => {
  const t = parseFeaturesMarkdown(DOC);
  assert.strictEqual(t[0].done, false);
  assert.strictEqual(t[2].done, true);
  assert.ok(!t[0].title.includes("🔴"));
});

test("parse: body ends at the next non-feature heading", () => {
  const t = parseFeaturesMarkdown(DOC);
  assert.ok(!t[2].description.includes("Changelog"));
});

test("flip: 🔴 → 🟢 on the id line only; reverse works; missing id → null", () => {
  const flipped = flipStatus(DOC, "F01", true);
  const line = flipped.split("\n").find((l) => l.includes("F01"));
  assert.ok(line.includes("🟢"), line);
  const back = flipStatus(flipped, "F01", false);
  assert.ok(back.split("\n").find((l) => l.includes("F01")).includes("🔴"));
  assert.strictEqual(flipStatus(DOC, "F99", true), null);
});

test("importFromFile: reads within the project, rejects escapes/missing", () => {
  const dir = fs.mkdtempSync("/tmp/nano-backlog-");
  fs.writeFileSync(path.join(dir, "docs.md"), DOC);
  const r = importFromFile(dir, "docs.md");
  assert.strictEqual(r.tickets.length, 3);
  assert.strictEqual(r.sourceDoc, "docs.md");
  assert.throws(() => importFromFile(dir, "../etc/passwd"), /escapes/);
  assert.throws(() => importFromFile(dir, "nope.md"), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("importFromFile: no feature headings → error", () => {
  const dir = fs.mkdtempSync("/tmp/nano-backlog2-");
  fs.writeFileSync(path.join(dir, "readme.md"), "# Nothing here\n");
  assert.throws(() => importFromFile(dir, "readme.md"), /no feature headings/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} backlog tests passed`);
process.exit(failed ? 1 : 0);
