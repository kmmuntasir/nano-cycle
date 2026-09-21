// Ticket store — per-project backlog persistence for the v3 ticket queue.
// Tickets live OUTSIDE target repos (the v1 §14 lesson): nano-cycle/tickets/<project>.json.
// The queue (host/queue.mjs) owns status transitions; this module owns the data.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// Tests point NANO_TICKETS_DIR at a throwaway dir — the default is the LIVE
// store, which `npm test` must never touch (it wiped real ticket data once).
const TICKETS_DIR = process.env.NANO_TICKETS_DIR
  ? path.resolve(process.env.NANO_TICKETS_DIR)
  : path.join(ROOT, "tickets");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const TICKET_STATUSES = [
  "draft", "clarifying", "clarified", "queued", "running", "done", "blocked",
];

function ticketsPath(project) {
  return path.join(TICKETS_DIR, `${project.replace(/[^\w.-]/g, "_")}.json`);
}

function defaultStore(project) {
  return {
    project,
    config: {
      models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
      options: { git: true, audit: true, security: "off", maxFixRounds: 2, remoteChecks: false },
    },
    tickets: [],
    queue: { state: "idle", pausedAt: null },
  };
}

/** The store directory (env-overridable for tests). */
export function ticketsDir() {
  return TICKETS_DIR;
}

export function loadTickets(project) {
  const p = ticketsPath(project);
  if (!fs.existsSync(p)) return defaultStore(project);
  try {
    const store = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...defaultStore(project), ...store };
  } catch {
    return defaultStore(project);
  }
}

export function saveTickets(project, store) {
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(ticketsPath(project), JSON.stringify(store, null, 2));
}

export function deleteTickets(project) {
  const p = ticketsPath(project);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

/** Create a ticket. id optional — auto-derived (T01, T02…) when absent. */
export function createTicket(project, { id, title, description, dependsOn = [], order }) {
  if (!title?.trim()) throw new Error("ticket title is required");
  const store = loadTickets(project);
  const finalId = String(id ?? "").trim() || nextAutoId(store);
  if (!ID_RE.test(finalId)) throw new Error(`ticket id "${finalId}" is not a valid slug (letters, digits, - _)`);
  if (store.tickets.some((t) => t.id === finalId)) throw new Error(`duplicate ticket id "${finalId}"`);
  const deps = normalizeDeps(dependsOn, store.tickets);
  const ticket = {
    id: finalId,
    title: String(title).trim(),
    description: String(description ?? "").trim(),
    sourceDoc: null,
    dependsOn: deps,
    order: Number.isFinite(order) ? order : store.tickets.length,
    status: "draft",
    blockedReason: null,
    runId: null,
    history: [{ at: new Date().toISOString(), from: null, to: "draft" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.tickets.push(ticket);
  saveTickets(project, store);
  return ticket;
}

function nextAutoId(store) {
  let n = store.tickets.length + 1;
  const taken = new Set(store.tickets.map((t) => t.id));
  while (taken.has(`T${String(n).padStart(2, "0")}`)) n += 1;
  return `T${String(n).padStart(2, "0")}`;
}

function normalizeDeps(dependsOn, existing) {
  const ids = new Set((existing ?? []).map((t) => t.id));
  const out = [];
  for (const d of dependsOn ?? []) {
    const k = String(d).trim();
    if (!ids.has(k)) throw new Error(`dependency "${k}" does not exist yet`);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Edit title/description/dependsOn/order. Dependency edits are cycle-checked. */
export function updateTicket(project, id, patch) {
  const store = loadTickets(project);
  const t = store.tickets.find((x) => x.id === id);
  if (!t) throw new Error(`unknown ticket "${id}"`);
  if (patch.title !== undefined) t.title = String(patch.title).trim();
  if (patch.description !== undefined) t.description = String(patch.description).trim();
  if (patch.order !== undefined) t.order = Number(patch.order) || 0;
  if (patch.sourceDoc !== undefined) t.sourceDoc = patch.sourceDoc;
  if (patch.dependsOn !== undefined) {
    const others = store.tickets.filter((x) => x.id !== id);
    t.dependsOn = normalizeDeps(patch.dependsOn, others);
    assertAcyclic(store.tickets.map((x) => (x.id === id ? { ...x, dependsOn: t.dependsOn } : x)));
  }
  t.updatedAt = new Date().toISOString();
  saveTickets(project, store);
  return t;
}

function assertAcyclic(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const mark = {};
  const visit = (id) => {
    if (mark[id] === 2) return;
    if (mark[id] === 1) throw new Error(`ticket dependency cycle at "${id}"`);
    mark[id] = 1;
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d);
    mark[id] = 2;
  };
  for (const t of tickets) visit(t.id);
}

export function deleteTicket(project, id) {
  const store = loadTickets(project);
  const before = store.tickets.length;
  store.tickets = store.tickets.filter((t) => t.id !== id);
  if (store.tickets.length === before) throw new Error(`unknown ticket "${id}"`);
  for (const t of store.tickets) {
    t.dependsOn = (t.dependsOn ?? []).filter((d) => d !== id);
  }
  saveTickets(project, store);
}

/** Status transition + history. The queue owns legal transitions; this only records. */
export function setTicketStatus(project, id, status, extra = {}) {
  const store = loadTickets(project);
  const t = store.tickets.find((x) => x.id === id);
  if (!t) throw new Error(`unknown ticket "${id}"`);
  const from = t.status;
  t.status = status;
  t.blockedReason = status === "blocked" ? (extra.reason ?? t.blockedReason ?? "unspecified") : null;
  if (extra.runId) t.runId = extra.runId;
  t.updatedAt = new Date().toISOString();
  t.history.push({ at: t.updatedAt, from, to: status, ...(extra.runId ? { runId: extra.runId } : {}), ...(extra.note ? { note: String(extra.note).slice(0, 300) } : {}) });
  saveTickets(project, store);
  return t;
}

export function setQueueState(project, patch) {
  const store = loadTickets(project);
  store.queue = { ...store.queue, ...patch };
  saveTickets(project, store);
  return store.queue;
}

export function setQueueConfig(project, patch) {
  const store = loadTickets(project);
  store.config = {
    models: { ...store.config.models, ...(patch.models ?? {}) },
    options: { ...store.config.options, ...(patch.options ?? {}) },
  };
  saveTickets(project, store);
  return store.config;
}

/** Import parsed tickets into the store (backlog import, pasted markdown, JSON).
 *  Existing ids are skipped so re-importing a doc is idempotent; `done` tickets
 *  (🟢/✅ markers) import as done. Dependencies may reference siblings created
 *  later in the same batch (two-pass). Returns { created, skipped } id lists. */
export function importTickets(project, { tickets, sourceDoc = null }) {
  const created = [];
  const skipped = [];
  const pendingDeps = [];
  for (const raw of tickets ?? []) {
    const id = String(raw.id ?? "").trim();
    if (id && loadTickets(project).tickets.some((x) => x.id === id)) {
      skipped.push(id);
      continue;
    }
    let t;
    try {
      t = createTicket(project, { id: id || undefined, title: raw.title, description: raw.description });
    } catch {
      skipped.push(id || "(invalid)");
      continue;
    }
    const doc = raw.sourceDoc ?? sourceDoc;
    if (doc) updateTicket(project, t.id, { sourceDoc: doc });
    if (Array.isArray(raw.dependsOn) && raw.dependsOn.length > 0) pendingDeps.push([t.id, raw.dependsOn]);
    if (raw.done === true) setTicketStatus(project, t.id, "done");
    created.push(t.id);
  }
  // Second pass: deps are cycle-checked against the now-complete sibling set.
  for (const [id, deps] of pendingDeps) {
    try {
      updateTicket(project, id, { dependsOn: deps });
    } catch {
      /* an unresolvable dep is dropped — the ticket imports dep-free rather than failing the batch */
    }
  }
  return { created, skipped };
}
