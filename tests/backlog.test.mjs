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

test("flip: heading WITHOUT a marker gains 🟢 with its markup preserved", () => {
  const doc = "## F07 — Brand new thing\nbody text\n";
  const flipped = flipStatus(doc, "F07", true);
  const line = flipped.split("\n")[0];
  assert.ok(line.startsWith("## F07"), `heading level intact: "${line}"`);
  assert.ok(line.includes("🟢"), line);
  assert.strictEqual(flipped.split("\n")[1], "body text", "body untouched");
  // bolded pseudo-heading shape keeps its bold too
  const bold = flipStatus("**F08) Bold title**\n", "F08", true);
  assert.ok(bold.startsWith("**F08)"), bold);
  assert.ok(bold.includes("🟢"), bold);
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

test("importFromFile: no feature entries → error", () => {
  const dir = fs.mkdtempSync("/tmp/nano-backlog2-");
  fs.writeFileSync(path.join(dir, "readme.md"), "# Nothing here\n");
  assert.throws(() => importFromFile(dir, "readme.md"), /no feature entries/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Checkbox-list style (the glm-monitor shape): entries are list items with
// [x]/[ ] checkboxes and bold titles; deps come from "Builds on:" lines.
const GDOC = `# Feature Breakdown

Intro prose mentioning F00 that must not become a ticket.

- F00 is the only system-structure feature (scaffolding) — prose, not an entry.

---

## Feature checklist

- [x] F00 — Project foundation
- [ ] F01 — Popup shell
- [ ] F02 — Local vault

---

## Features

- [x] **F00 — Project foundation**

  Foundation done. Indented detail body.

  **Acceptance.** Loads unpacked.

- [ ] **F01 — Popup shell**

  Builds on: F00. PRD: §5.1.

  Detail body for F01.

- [ ] **F02 — Local vault**

  Builds on: F01.

  Detail body for F02.

## Milestone mapping (informational)

- M1 → F00, F01
`;

test("parse: checkbox-list entries, [x] status, dedup vs checklist, Builds-on deps", () => {
  const t = parseFeaturesMarkdown(GDOC);
  assert.deepStrictEqual(t.map((x) => x.id), ["F00", "F01", "F02"], JSON.stringify(t.map((x) => x.id)));
  const byId = Object.fromEntries(t.map((x) => [x.id, x]));
  assert.strictEqual(byId.F00.done, true, "[x] imports as done");
  assert.strictEqual(byId.F01.done, false);
  assert.ok(byId.F00.description.includes("Foundation done"), "detailed body wins over the checklist duplicate");
  assert.deepStrictEqual(byId.F00.dependsOn, []);
  assert.deepStrictEqual(byId.F01.dependsOn, ["F00"], "Builds on: F00 → dependsOn");
  assert.deepStrictEqual(byId.F02.dependsOn, ["F01"]);
  assert.ok(!byId.F00.description.includes("Milestone mapping"), "section ends at the next heading");
  assert.ok(!t.some((x) => x.title === "."), "the old F12).-style false positive can't happen (structural marker required)");
});

test("parse: prose lines starting with an id are never entries", () => {
  const t = parseFeaturesMarkdown(GDOC);
  // the "- F00 is the only system-structure feature" bullet has no punctuation
  // separator → prose, not an entry (only 3 ids total)
  assert.strictEqual(t.length, 3);
});

test("flip: checkbox entries [ ] ↔ [x] on every entry line for the id", () => {
  const flipped = flipStatus(GDOC, "F01", true);
  const lines = flipped.split("\n").filter((l) => l.includes("F01 —"));
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.every((l) => l.includes("[x]")), JSON.stringify(lines));
  const back = flipStatus(flipped, "F01", false);
  assert.ok(back.split("\n").filter((l) => l.includes("F01 —")).every((l) => l.includes("[ ]")));
  assert.strictEqual(flipStatus(GDOC, "F99", true), null);
});

test("parse: generalized ids — GM-##, NANO-###, F1 with punctuation; prose excluded", () => {
  const md = [
    "## GM-101 — Queue worker",
    "Body one.",
    "## NANO-42: Retry policy",
    "Body two.",
    "## A10 Cleanup pass",
    "Body three.",
    "## F1 — Solo feature",
    "Body four.",
    "## V1 Roadmap",
    "Must NOT import (single letter+digit, bare-space separator).",
    "## B2 Something else",
    "Must NOT import either.",
  ].join("\n");
  const t = parseFeaturesMarkdown(md);
  assert.deepStrictEqual(t.map((x) => x.id), ["GM-101", "NANO-42", "A10", "F1"], JSON.stringify(t.map((x) => x.id)));
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} backlog tests passed`);
process.exit(failed ? 1 : 0);
