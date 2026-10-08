// Ticket store unit tests — TODO 5. Run: node tests/tickets.test.mjs
import "./_test-dirs.mjs"; // FIRST: isolate tickets/runs stores (never the live data)
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createTicket, updateTicket, deleteTicket, setTicketStatus, loadTickets, saveTickets, importTickets, ticketsDir } from "../host/tickets.mjs";

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`); }
};

const PROJ = "tick-fixture";

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

// --- Q-H5: atomic writes, corrupt stores are never treated as empty -----------

test("Q-H5: saves are atomic — no temp files left, file always parses", () => {
  const P = "tick-atomic";
  createTicket(P, { title: "a" });
  for (let i = 0; i < 20; i++) setTicketStatus(P, "T01", i % 2 ? "draft" : "clarified");
  const leftovers = fs.readdirSync(ticketsDir()).filter((f) => f.startsWith(`${P}.`) && f.endsWith(".tmp"));
  assert.deepStrictEqual(leftovers, [], "no stray temp files");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ticketsDir(), `${P}.json`), "utf8")));
});

test("Q-H5: a failed write leaves the previous store intact (rename never happens)", () => {
  const P = "tick-failwrite";
  createTicket(P, { title: "keep me" });
  const file = path.join(ticketsDir(), `${P}.json`);
  const before = fs.readFileSync(file, "utf8");
  const store = loadTickets(P);
  store.tickets[0].self = store; // circular → JSON.stringify throws mid-save
  assert.throws(() => saveTickets(P, store));
  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "original bytes untouched");
  assert.deepStrictEqual(fs.readdirSync(ticketsDir()).filter((f) => f.startsWith(`${P}.`) && f.endsWith(".tmp")), []);
});

test("Q-H5: a corrupt store is NOT read as empty — error + .corrupt backup + writes refused", () => {
  const P = "tick-corrupt";
  createTicket(P, { title: "precious" });
  const file = path.join(ticketsDir(), `${P}.json`);
  const good = fs.readFileSync(file, "utf8");
  const truncated = good.slice(0, Math.floor(good.length / 2));
  fs.writeFileSync(file, truncated);
  assert.throws(() => loadTickets(P), (e) => e.code === "TICKETS_CORRUPT" && /corrupt/.test(e.message));
  const backups = fs.readdirSync(ticketsDir()).filter((f) => f.startsWith(`${P}.json.corrupt-`));
  assert.strictEqual(backups.length, 1, "a backup of the corrupt bytes was kept");
  assert.strictEqual(fs.readFileSync(path.join(ticketsDir(), backups[0]), "utf8"), truncated);
  // every mutator refuses; the corrupt file is never overwritten with a fresh store
  assert.throws(() => saveTickets(P, { project: P, tickets: [], queue: {}, config: {} }), /corrupt/);
  assert.throws(() => createTicket(P, { title: "new" }), /corrupt/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), truncated, "file untouched");
  // repair (restore the good bytes) → reads and writes work again
  fs.writeFileSync(file, good);
  assert.strictEqual(loadTickets(P).tickets[0].title, "precious");
  createTicket(P, { title: "after repair" });
  assert.strictEqual(loadTickets(P).tickets.length, 2);
});

test("Q-H5: a JSON value that is not a store object counts as corrupt too", () => {
  const P = "tick-null";
  fs.mkdirSync(ticketsDir(), { recursive: true });
  fs.writeFileSync(path.join(ticketsDir(), `${P}.json`), "null");
  assert.throws(() => loadTickets(P), /corrupt/);
});

test("Q-H2: cascade remembers where a ticket was (blockedFrom) and clears it when unblocked", () => {
  const P = "tick-from";
  createTicket(P, { id: "A", title: "a" });
  setTicketStatus(P, "A", "blocked", { reason: "depends on X", from: "draft" });
  assert.strictEqual(loadTickets(P).tickets[0].blockedFrom, "draft");
  setTicketStatus(P, "A", "blocked", { reason: "depends on X" }); // re-block keeps the origin
  assert.strictEqual(loadTickets(P).tickets[0].blockedFrom, "draft");
  setTicketStatus(P, "A", "draft");
  assert.strictEqual(loadTickets(P).tickets[0].blockedFrom, null);
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ticket store tests passed`);
process.exit(failed ? 1 : 0);
