// Backlog import + status flip — the bridge between a repo's own features doc
// and the ticket store. Import is read-only; the ONLY write is the deliberate
// status flip committed on the base branch when a ticket completes.
//
// The parser is deliberately lenient across the shapes real projects use:
//   omni-isp style      "## F01 — Monorepo scaffold 🔴"
//   checkbox-list style "- [x] **F00 — Project foundation and tooling**"
//                       with "Builds on: F05." dependency lines
// Any PROJECT-PREFIX id works (F##, OMNI-###, GM-##, NANO-##…). It is still
// pattern matching, though — for docs outside these shapes, structure the
// tickets with an agent and push them via the MCP server (host/mcp-tickets.mjs
// nano_bulk_create_tickets) or POST /api/tickets/:project/import {json}.
import fs from "node:fs";
import path from "node:path";

// A feature id token: F00, F1, OMNI-200, GM-12, NANO-42 — letters[-]digits.
// Single-letter+single-digit forms ("F1") are close to prose ("V1") and need a
// punctuation separator on the entry line to qualify (checked in parseEntryLine).
const ID_SRC = "[A-Z][A-Z0-9]{0,9}-\\d{1,5}|[A-Z]\\d{1,5}";
const ID_TOKEN_RE = new RegExp(`^(${ID_SRC})$`, "i");

// Ids mentioned inside a dependency line ("Builds on: F05. PRD: §6.2").
const ID_IN_TEXT_RE = new RegExp(ID_SRC, "gi");

// A dependency line anywhere in a body: "Builds on: F05", "**Depends on:** F00, F01".
const DEP_LINE_RE = /^\s*\**\s*(?:builds|depends)\s+on\b/i;

export function slugifyId(raw) {
  return String(raw).trim().toUpperCase();
}

/** Parse one line as a feature ENTRY (the line that opens a ticket).
 *  A structural marker is REQUIRED — heading, list bullet, checkbox, or bold —
 *  so body sentences that merely start with an id ("F12)." after a wrap) never
 *  become tickets. Returns null when the line isn't an entry. */
function parseEntryLine(line) {
  const indent = (line.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "  ").length;
  let rest = line.trim();
  let kind = null; // "heading" | "list" | "bold"
  let done; // undefined = no explicit marker on this line
  let checkbox = false;
  let hasEmoji = false;
  let m;
  let level = 0;
  if ((m = rest.match(/^(#{1,6})\s+(.*)$/))) {
    kind = "heading";
    level = m[1].length;
    rest = m[2];
  } else {
    let listish = false;
    if ((m = rest.match(/^[-*+]\s+(.*)$/))) {
      listish = true;
      rest = m[1];
    }
    if ((m = rest.match(/^\[([ xX])\]\s*(.*)$/))) {
      checkbox = true;
      done = m[1] !== " ";
      rest = m[2];
    }
    const bold = rest.match(/^\*\*(.+?)\*\*$/);
    if (bold) rest = bold[1];
    if (bold || listish || checkbox) kind = bold && !listish && !checkbox ? "bold" : "list";
  }
  if (!kind) return null;
  // id + separator + title. Headings may separate with plain whitespace; list
  // and bold shapes REQUIRE punctuation (—, :, -, ), ], .) — "- F00 is the
  // only system-structure feature…" is prose, not an entry.
  const sep = kind === "heading" ? "(\\s*[—–:\\-)\\].]\\s*|\\s+)" : "(\\s*[—–:\\-)\\].]\\s*)";
  m = rest.match(new RegExp(`^(${ID_SRC})${sep}(.+)$`, "i"));
  if (!m) return null;
  // Single-letter+single-digit ids ("F1") separated from the title by bare
  // whitespace are too close to prose ("V1 Roadmap") — require punctuation.
  if (/^[A-Z]\d$/i.test(m[1]) && /^\s*$/.test(m[2])) return null;
  const id = slugifyId(m[1]);
  let title = m[3].trim(); // group 2 is the separator
  const emoji = title.match(/(\u{1F534}|\u{1F7E0}|✅|\u{1F7E2})/u);
  if (emoji) {
    hasEmoji = true;
    if (done === undefined) done = emoji[0] === "🟢" || emoji[0] === "✅";
    title = title.replace(/(\u{1F534}|\u{1F7E0}|✅|\u{1F7E2})/gu, "").trim();
  }
  if (!ID_TOKEN_RE.test(id) || title.length < 2) return null;
  return { id, title, kind, done: done ?? false, checkbox, hasEmoji, indent, level };
}

// A body line that is JUST a status marker ("- 🟢", "status: ✅") flips done.
const BODY_MARKER_RE = /^[-*]?\s*(?:status\s*[:\-]?\s*)?(\u{1F534}|\u{1F7E0}|✅|\u{1F7E2})\s*$/iu;

function extractDeps(body) {
  for (const raw of body.split(/\r?\n/)) {
    if (!DEP_LINE_RE.test(raw)) continue;
    const ids = [...raw.matchAll(ID_IN_TEXT_RE)].map((m) => slugifyId(m[0]));
    const uniq = [...new Set(ids)].slice(0, 5);
    if (uniq.length > 0) return uniq;
  }
  return [];
}

/** Parse a features markdown doc into tickets.
 *  Status comes from 🔴/🟢/✅ markers or [x]/[ ] checkboxes; dependencies from
 *  "Builds on: F05" lines. Duplicate ids (a checklist summary + a detailed
 *  section) merge into the entry with the longer description. */
export function parseFeaturesMarkdown(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const found = new Map(); // id -> {id,title,description,done,dependsOn}
  let current = null;
  const flush = () => {
    if (!current) return;
    current.dependsOn = extractDeps(current.description);
    const prev = found.get(current.id);
    if (!prev) {
      found.set(current.id, current);
      return;
    }
    // duplicate id (checklist summary vs detailed section): keep the richer
    // body, OR the done flags, and any deps the other one found.
    const [keep, drop] = current.description.length >= prev.description.length ? [current, prev] : [prev, current];
    keep.done = keep.done || drop.done;
    if (keep.dependsOn.length === 0) keep.dependsOn = drop.dependsOn;
    found.set(keep.id, keep);
    current = null;
  };

  for (const line of lines) {
    const entry = parseEntryLine(line);
    if (entry) {
      flush();
      current = { ...entry, description: "", dependsOn: [] };
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,6})\s+/);
    const hr = /^(-{3,}|\*{3,})$/.test(trimmed);
    if (current.kind === "heading") {
      // A non-entry heading at or above our level ends the section.
      if (heading && heading[1].length <= (current.level || 1)) {
        flush();
        continue;
      }
      if (hr) {
        flush();
        continue;
      }
    } else {
      // List/bold entries own their indented continuation block: a non-blank
      // un-indented line (any heading, any hr, any stray prose) ends it.
      const indent = (line.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "  ").length;
      if (trimmed !== "" && indent < 2) {
        flush();
        continue;
      }
    }
    if (BODY_MARKER_RE.test(trimmed) && trimmed.match(/🟢|✅/u)) current.done = true;
    const deindent = current.kind === "heading" ? line : line.replace(/^ {1,2}/, "");
    current.description += (current.description ? "\n" : "") + deindent;
  }
  flush();
  return [...found.values()].map(({ id, title, description, done, dependsOn }) => ({
    id,
    title,
    description: description.trim(),
    done,
    dependsOn,
  }));
}

/** Import a doc file into tickets (does NOT modify the file). */
export function importFromFile(projectPath, relPath) {
  const abs = path.resolve(projectPath, relPath);
  if (!abs.startsWith(path.resolve(projectPath))) throw new Error("import path escapes the project");
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${relPath}`);
  const tickets = parseFeaturesMarkdown(fs.readFileSync(abs, "utf8"));
  if (tickets.length === 0) {
    throw new Error(
      `no feature entries found in ${relPath} — expected ids like F##/OMNI-###/GM-## on headings ("## F01 — Title") or list items ("- [x] **F01 — Title**"); ` +
        `other formats: have an agent structure the doc and use the nano-cycle MCP (nano_bulk_create_tickets) or POST a JSON ticket array`,
    );
  }
  return { tickets, sourceDoc: relPath.replace(/\\/g, "/") };
}

/** Flip a ticket's status marker in the doc text: 🔴/none → 🟢 (done), 🟢 → 🔴;
 *  `[ ]` ↔ `[x]` for checkbox-style entries. Every ENTRY line carrying the id
 *  flips (a checklist line and its detailed section stay consistent). Returns
 *  the new text, or null when no entry line for the id is found. */
export function flipStatus(docText, id, done = true) {
  const want = slugifyId(id);
  const lines = String(docText ?? "").split(/\r?\n/);
  let changed = false;
  const out = lines.map((line) => {
    const entry = parseEntryLine(line);
    if (!entry || entry.id !== want) return line;
    let next = line;
    if (entry.checkbox) next = done ? line.replace("[ ]", "[x]") : line.replace(/\[[xX]\]/, "[ ]");
    else if (entry.hasEmoji) next = done ? line.replace("🔴", "🟢") : line.replace("🟢", "🔴");
    else if (done) next = line.replace(/\s+$/, "") + " 🟢";
    if (next !== line) changed = true;
    return next;
  });
  return changed ? out.join("\n") : null;
}
