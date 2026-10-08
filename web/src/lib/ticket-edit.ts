// Editing a ticket against a server record that may change underneath us
// (the queue, an MCP agent, another browser). The editor works on a draft
// plus the `base` it was started from; Save sends only fields the user
// actually changed, and external updates flow into untouched fields.

export interface TicketFields {
  title: string;
  description: string;
  dependsOn: string; // comma-separated, as typed
  order: string;
}

export type TicketFieldKey = keyof TicketFields;
export const TICKET_FIELDS: TicketFieldKey[] = ["title", "description", "dependsOn", "order"];

interface TicketLike {
  title: string;
  description: string;
  dependsOn: string[];
  order?: number;
}

export const parseDeps = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

export function fieldsOf(t: TicketLike): TicketFields {
  return { title: t.title, description: t.description, dependsOn: t.dependsOn.join(", "), order: String(t.order ?? 0) };
}

function sameField(k: TicketFieldKey, a: TicketFields, b: TicketFields): boolean {
  if (k === "dependsOn") return parseDeps(a.dependsOn).join("\n") === parseDeps(b.dependsOn).join("\n");
  if (k === "order") return (Number(a.order) || 0) === (Number(b.order) || 0);
  return a[k] === b[k];
}

/** Fields the user changed relative to what the editor started from. */
export function changedPatch(base: TicketFields, draft: TicketFields): Partial<{ title: string; description: string; dependsOn: string[]; order: number }> {
  const patch: Partial<{ title: string; description: string; dependsOn: string[]; order: number }> = {};
  if (!sameField("title", base, draft)) patch.title = draft.title;
  if (!sameField("description", base, draft)) patch.description = draft.description;
  if (!sameField("dependsOn", base, draft)) patch.dependsOn = parseDeps(draft.dependsOn);
  if (!sameField("order", base, draft)) patch.order = Number(draft.order) || 0;
  return patch;
}

/**
 * Fold a newer server record into an open editor. Untouched fields (draft ==
 * base) adopt the server value; fields the user is editing keep their text,
 * and `conflicts` lists those where the server value also moved.
 */
export function mergeExternal(
  base: TicketFields,
  draft: TicketFields,
  server: TicketFields,
): { base: TicketFields; draft: TicketFields; conflicts: TicketFieldKey[] } {
  const nextBase = { ...base };
  const nextDraft = { ...draft };
  const conflicts: TicketFieldKey[] = [];
  for (const k of TICKET_FIELDS) {
    if (sameField(k, base, server)) continue; // server didn't move this field
    if (sameField(k, base, draft)) {
      nextBase[k] = server[k];
      nextDraft[k] = server[k];
    } else {
      // The user is mid-edit on this field: keep their text, but rebase so a
      // later Save still sends it (it is a deliberate overwrite) and flag it.
      nextBase[k] = server[k];
      if (!sameField(k, draft, server)) conflicts.push(k);
    }
  }
  return { base: nextBase, draft: nextDraft, conflicts };
}
