// Ticket store unit tests — TODO 5. Run: node tests/tickets.test.mjs
import fs from "node:fs";
import assert from "node:assert";
import { createTicket, updateTicket, deleteTicket, setTicketStatus, loadTickets, importTickets } from "../host/tickets.mjs";

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`); }
};

const PROJ = "tick-fixture";
process.on("exit", () => { try { fs.rmSync("tickets", { recursive: true, force: true }); } catch {} });
fs.rmSync("tickets", { recursive: true, force: true });

test("create: auto id, defaults, persistence round-trip", () => {
  const t = createTicket(PROJ, { title: "First", description: "do it" });
  assert.strictEqual(t.id, "T01");
  assert.strictEqual(t.status, "draft");
  const store = loadTickets(PROJ);
  assert.strictEqual(store.tickets.length, 1);
  assert.strictEqual(store.tickets[0].title, "First");
});

test("create: explicit id; duplicate/bad-slug/unknown-dep rejected", () => {
  createTicket(PROJ, { id: "F02", title: "Second" });
  assert.throws(() => createTicket(PROJ, { id: "F02", title: "dup" }), /duplicate/);
  assert.throws(() => createTicket(PROJ, { id: "bad slug!", title: "x" }), /slug/);
  assert.throws(() => createTicket(PROJ, { id: "F03", title: "x", dependsOn: ["nope"] }), /does not exist/);
  const t = createTicket(PROJ, { id: "F03", title: "x", dependsOn: ["T01"] });
  assert.deepStrictEqual(t.dependsOn, ["T01"]);
});

test("update: dependency cycle rejected; acyclic edits accepted", () => {
  assert.throws(() => updateTicket(PROJ, "T01", { dependsOn: ["F03"] }), /cycle/); // T01→F03→T01
  const t = updateTicket(PROJ, "F03", { dependsOn: ["F02"] }); // F03→F02, no cycle (T01 has no deps)
  assert.deepStrictEqual(t.dependsOn, ["F02"]);
});

test("delete: removes ticket and strips it from others' deps", () => {
  createTicket(PROJ, { id: "F04", title: "dep on F03", dependsOn: ["F03"] });
  deleteTicket(PROJ, "F03");
  const store = loadTickets(PROJ);
  assert.ok(!store.tickets.some((t) => t.id === "F03"));
  assert.deepStrictEqual(store.tickets.find((t) => t.id === "F04").dependsOn, []);
  assert.throws(() => deleteTicket(PROJ, "F03"), /unknown/);
});

test("status transitions recorded in history; blocked keeps reason", () => {
  setTicketStatus(PROJ, "T01", "clarifying", { runId: "r-1" });
  setTicketStatus(PROJ, "T01", "clarified");
  setTicketStatus(PROJ, "T01", "blocked", { reason: "gates-exhausted" });
  const store = loadTickets(PROJ);
  const t = store.tickets.find((x) => x.id === "T01");
  assert.strictEqual(t.status, "blocked");
  assert.strictEqual(t.blockedReason, "gates-exhausted");
  assert.strictEqual(t.runId, "r-1");
  assert.deepStrictEqual(t.history.map((h) => h.to), ["draft", "clarifying", "clarified", "blocked"]);
});

test("importTickets: creates with sourceDoc + done flag, skips existing, forward deps", () => {
  const out = importTickets("tick-import", {
    tickets: [
      { id: "F01", title: "one", description: "d1", done: false },
      { id: "F02", title: "two", description: "d2", dependsOn: ["F03"], done: true },
      { id: "F03", title: "three", description: "d3" },
    ],
    sourceDoc: "docs/features.md",
  });
  assert.deepStrictEqual(out, { created: ["F01", "F02", "F03"], skipped: [] });
  const store = loadTickets("tick-import");
  assert.strictEqual(store.tickets.length, 3);
  assert.ok(store.tickets.every((t) => t.sourceDoc === "docs/features.md"), "sourceDoc provenance recorded");
  assert.strictEqual(store.tickets.find((t) => t.id === "F02").status, "done", "🟢-style done flag imports as done");
  assert.deepStrictEqual(store.tickets.find((t) => t.id === "F02").dependsOn, ["F03"], "dep on a later sibling resolves (two-pass)");
  // re-import is idempotent
  const again = importTickets("tick-import", { tickets: [{ id: "F01", title: "one", description: "d1" }], sourceDoc: "docs/features.md" });
  assert.deepStrictEqual(again, { created: [], skipped: ["F01"] });
  assert.strictEqual(loadTickets("tick-import").tickets.length, 3);
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ticket store tests passed`);
process.exit(failed ? 1 : 0);
