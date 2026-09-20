// Backlog import + status flip — the bridge between a repo's own features doc
// and the ticket store. Import is read-only; the ONLY write is the deliberate
// status flip (🔴 → 🟢) committed on the base branch when a ticket completes.
import fs from "node:fs";
import path from "node:path";

// A feature heading: "## F01 — Title", "### OMNI-200: Title", "**F01) Title**"…
const HEAD_RE = /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*((?:F|OMNI-)\d{1,4})\s*(?:[—–:\-)\]]\s*)?(.+?)\s*(?:\*\*)?\s*$/i;
const STATUS_EMOJI = /(\u{1F534}|\u{1F7E0}|\u2705|\u{1F7E2})/gu;

export function slugifyId(raw) {
  return String(raw).trim().toUpperCase();
}

/** Parse a features markdown doc into tickets.
 *  🔴 / no marker → open (draft); 🟢 / ✅ → already done (imported as done). */
export function parseFeaturesMarkdown(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const tickets = [];
  let current = null;
  let currentLevel = 0;
  const flush = () => {
    if (current) tickets.push(current);
    current = null;
  };
  for (const line of lines) {
    const heading = line.match(/^(\#{1,6})\s+/);
    const m = line.match(HEAD_RE);
    if (m && (!heading || true)) {
      // A feature id heading (its own heading level); stop the previous ticket.
      flush();
      currentLevel = heading ? heading[1].length : 0;
      const id = slugifyId(m[1]);
      let title = String(m[2] ?? "").trim();
      let done = false;
      const emoji = title.match(STATUS_EMOJI);
      if (emoji) {
        done = emoji[0] === "🟢" || emoji[0] === "✅";
        title = title.replace(STATUS_EMOJI, "").trim();
      }
      current = { id, title: title || id, description: "", done, sourceLine: line.trim() };
      continue;
    }
    if (current) {
      // A non-id heading at or above our level ends the section.
      if (heading && heading[1].length <= Math.max(2, currentLevel)) {
        flush();
        continue;
      }
      const emoji = line.trim().match(STATUS_EMOJI);
      if (emoji && emoji[0] === "🟢") current.done = true;
      current.description += (current.description ? "\n" : "") + line;
    }
  }
  flush();
  return tickets
    .filter((t) => t.description.trim().length > 0 || t.title)
    .map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description.trim(),
      done: t.done,
    }));
}

/** Import a doc file into tickets (does NOT modify the file). */
export function importFromFile(projectPath, relPath) {
  const abs = path.resolve(projectPath, relPath);
  if (!abs.startsWith(path.resolve(projectPath))) throw new Error("import path escapes the project");
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${relPath}`);
  const tickets = parseFeaturesMarkdown(fs.readFileSync(abs, "utf8"));
  if (tickets.length === 0) throw new Error(`no feature headings (F##/OMNI-###) found in ${relPath}`);
  return { tickets, sourceDoc: relPath.replace(/\\/g, "/") };
}

/** Flip a ticket's status marker in the doc text: 🔴/none → 🟢 (done), 🟢 → 🔴.
 *  Returns the new text, or null when the id line isn't found. The heading's
 *  markup (level, bold) is PRESERVED — the marker is swapped/appended in place. */
export function flipStatus(docText, id, done = true) {
  const lines = String(docText ?? "").split(/\r?\n/);
  let changed = false;
  const out = lines.map((line) => {
    if (changed || !line.includes(id)) return line;
    if (!HEAD_RE.test(line)) return line;
    changed = true;
    if (done) {
      if (line.includes("🔴")) return line.replace("🔴", "🟢");
      if (line.includes("🟢")) return line;
      return line.replace(/\s+$/, "") + " 🟢";
    }
    return line.includes("🟢") ? line.replace("🟢", "🔴") : line;
  });
  return changed ? out.join("\n") : null;
}
