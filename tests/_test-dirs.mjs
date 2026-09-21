// Test isolation — import this FIRST in every test that touches stores.
// Declaration order guarantees this module's body evaluates before any host
// module is loaded, so tickets.mjs / state.mjs resolve their dirs to
// throwaway temp directories. Without this, `npm test` ran against the LIVE
// tickets/ store and wiped it on exit (real data loss, 2026-09-21 — the
// glm-monitor queue store died mid-validation).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const mk = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `nano-test-${name}-`));
const tickets = mk("tickets");
const runs = mk("runs");
process.env.NANO_TICKETS_DIR = tickets;
process.env.NANO_RUNS_DIR = runs;

process.on("exit", () => {
  for (const d of [tickets, runs]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

export { tickets, runs };
