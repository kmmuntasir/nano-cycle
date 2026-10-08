import type { RunEvent } from "../api";

// Console output renders as collapsible blocks, not a raw stream. Streaming
// text/think deltas arrive as tiny fragments, so consecutive same-type events
// from a node are coalesced into one block per burst. Pure so it can be
// memoised by the view and unit-tested.

export interface Block {
  key: string;
  t: string;
  nodeId: string;
  ts: number;
  text: string;
  name?: string;
  args?: string;
  ok?: boolean;
  usage?: Record<string, number>;
  count: number;
}

// Cheap intrinsic disambiguator for single-event blocks — parallel tool calls
// land in the same millisecond, and identical keys would expand together.
export const hash32 = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Node filter first, then coalesce streamed bursts into blocks. */
export function buildBlocks(events: RunEvent[], nodeId: string | null): Block[] {
  const out: Block[] = [];
  // Parallel lanes interleave their streamed deltas (two coders thinking at
  // once alternate token-by-token), so adjacency alone can't define a burst:
  // keep one open block per node+type and only a discrete event from the
  // same node (tool call, result, usage, notice) closes its open bursts.
  const open = new Map<string, Block>();
  for (const e of events) {
    if (nodeId && e.nodeId !== nodeId) continue;
    const t = e.ev.t;
    // Intrinsic key — node+ts+type of the block's own first event. Must not
    // depend on list position: live runs rotate a ~3000-event buffer, so
    // positional keys (indexes, ordinals) churn on every message and would
    // collapse expanded rows under the user's cursor. Streamed text/think
    // blocks exclude content (it grows); single-event blocks mix in a
    // content hash so same-millisecond twins stay independently expandable.
    const single = t !== "text" && t !== "think";
    if (single) {
      const h = `:${hash32(`${e.ev.name ?? ""}|${e.ev.args ?? ""}|${e.ev.ok ?? ""}|${JSON.stringify(e.ev.usage ?? {})}`)}`;
      // A discrete event from this node closes its open streamed bursts —
      // think → tool → think reads as two Thinking blocks, not one.
      open.delete(`${e.nodeId}:text`);
      open.delete(`${e.nodeId}:think`);
      out.push({
        key: `${e.nodeId}:${e.ts}:${t}${h}`,
        t,
        nodeId: e.nodeId,
        ts: e.ts,
        text: e.ev.s ?? "",
        name: e.ev.name,
        args: e.ev.args,
        ok: e.ev.ok,
        usage: e.ev.usage,
        count: 1,
      });
    } else {
      const k = `${e.nodeId}:${t}`;
      const blk = open.get(k);
      if (blk) {
        blk.text += e.ev.s ?? "";
        blk.count += 1;
        continue;
      }
      const nb: Block = { key: `${e.nodeId}:${e.ts}:${t}`, t, nodeId: e.nodeId, ts: e.ts, text: e.ev.s ?? "", count: 1 };
      open.set(k, nb);
      out.push(nb);
    }
  }
  return out;
}

/** Type + free-text filter over already-built blocks. */
export function filterBlocks(blocks: Block[], typeFilter: string, query: string): Block[] {
  let filtered = blocks;
  if (typeFilter === "errors") filtered = filtered.filter((b) => (b.t === "tool_end" && !b.ok) || b.t === "notice");
  else if (typeFilter !== "all") filtered = filtered.filter((b) => b.t === typeFilter);
  const q = query.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((b) => `${b.nodeId} ${b.text} ${b.name ?? ""} ${b.args ?? ""}`.toLowerCase().includes(q));
  }
  return filtered;
}

/** Events per node in one pass (the sidebar used to filter once per node per render). */
export function countByNode(events: RunEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.nodeId, (m.get(e.nodeId) ?? 0) + 1);
  return m;
}
