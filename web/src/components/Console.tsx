import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Input, Text } from "@chakra-ui/react";
import { SelectEl } from "../ui/controls";
import { GhostButton, OutlineButton } from "../ui/buttons";
import { fmtTimestamp, fmtTokens } from "../lib/format";
import type { RunEvent, RunState } from "../api";

const titleCase = (s: string) =>
  s
    .split(/[\s-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

const DOT: Record<string, string> = {
  queued: "#8b91a0",
  running: "#7aa2f7",
  done: "#4fd6a8",
  failed: "#f16a6a",
  cancelled: "#8b91a0",
};

// ---------------------------------------------------------------------------
// Output renders as collapsible blocks, not a raw terminal stream. Streaming
// text/think deltas arrive as tiny fragments, so consecutive same-type events
// from a node are coalesced into one block per burst. A collapsed block is a
// single row — arrow, type label, one-line preview, timestamp — and the full
// content only appears on expand.
// ---------------------------------------------------------------------------

interface Block {
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

const TYPE_LABEL: Record<string, string> = {
  text: "Text",
  think: "Thinking",
  tool: "Tool Call",
  tool_end: "Tool Result",
  usage: "Usage",
  notice: "Notice",
};

const TYPE_COLOR: Record<string, string> = {
  text: "#4fd6a8",
  think: "#8b91a0",
  tool: "#7aa2f7",
  tool_end: "#4fd6a8",
  usage: "#8b91a0",
  notice: "#f0b429",
};

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Cheap intrinsic disambiguator for single-event blocks — parallel tool calls
// land in the same millisecond, and identical keys would expand together.
const hash32 = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

// Args arrive as a JSON string (host-side preview may have truncated it);
// pretty-print when it still parses.
const prettyArgs = (args: string): string => {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
};

const previewOf = (b: Block): string => {
  if (b.t === "tool") return cap(`${b.name ?? "tool"} ${b.args ?? ""}`.trim(), 160);
  if (b.t === "tool_end") return `${b.ok ? "✔" : "✘"} ${b.name ?? "tool"}${b.ok ? "" : " (error)"}`;
  if (b.t === "usage")
    return `▲ ${fmtTokens(b.usage?.input ?? 0)}  ▼ ${fmtTokens(b.usage?.output ?? 0)}  cache ${fmtTokens(b.usage?.cacheRead ?? 0)}`;
  return cap(b.text.replace(/\s+/g, " ").trim() || "(empty)", 240);
};

// Full content shown when a block is expanded. Huge bodies are capped so a
// pathological artifact can't stall the DOM.
const BODY_CAP = 20_000;
const bodyOf = (b: Block): { text: string; truncated: boolean } => {
  if (b.t === "tool")
    return { text: b.args ? prettyArgs(b.args) : "(no args captured)", truncated: (b.args?.length ?? 0) > BODY_CAP };
  if (b.t === "tool_end") return { text: `${b.ok ? "completed" : "failed"} · ${b.name ?? "tool"}`, truncated: false };
  if (b.t === "usage")
    return {
      text: `input ▲ ${b.usage?.input ?? 0}   output ▼ ${b.usage?.output ?? 0}   cache read ${b.usage?.cacheRead ?? 0}`,
      truncated: false,
    };
  return { text: b.text || "(empty)", truncated: b.text.length > BODY_CAP };
};

export default function Console({
  events,
  nodes,
  nodeId,
  setNodeId,
  height = "52vh",
  runStart,
  eventsTotal,
}: {
  events: RunEvent[];
  nodes: RunState["nodes"];
  nodeId: string | null;
  setNodeId: (id: string | null) => void;
  height?: string;
  runStart: number;
  eventsTotal?: number | null;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Follow mode: stick to the bottom only while the user is already there.
  // Scrolling up pins the view; scrolling back to the bottom resumes follow.
  const [stick, setStick] = useState(true);

  const countOf = (id: string) => events.filter((e) => e.nodeId === id).length;

  // Node filter first (steps sidebar), then coalesce, then type/query — so a
  // "Thinking"-only view merges fragments that tool calls split apart live.
  const blocks = useMemo(() => {
    const list = nodeId ? events.filter((e) => e.nodeId === nodeId) : events;
    const out: Block[] = [];
    // Parallel lanes interleave their streamed deltas (two coders thinking at
    // once alternate token-by-token), so adjacency alone can't define a burst:
    // keep one open block per node+type and only a discrete event from the
    // same node (tool call, result, usage, notice) closes its open bursts.
    const open = new Map<string, Block>();
    for (const e of list) {
      const t = e.ev.t;
      // Intrinsic key — node+ts+type of the block's own first event. Must not
      // depend on list position: live runs rotate a ~3000-event buffer, so
      // positional keys (indexes, ordinals) churn on every message and would
      // collapse expanded rows under the user's cursor. Streamed text/think
      // blocks exclude content (it grows); single-event blocks mix in a
      // content hash so same-millisecond twins stay independently expandable.
      const single = t !== "text" && t !== "think";
      const h = single ? `:${hash32(`${e.ev.name ?? ""}|${e.ev.args ?? ""}|${e.ev.ok ?? ""}|${JSON.stringify(e.ev.usage ?? {})}`)}` : "";
      if (single) {
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
        const nb: Block = {
          key: `${e.nodeId}:${e.ts}:${t}`,
          t,
          nodeId: e.nodeId,
          ts: e.ts,
          text: e.ev.s ?? "",
          count: 1,
        };
        open.set(k, nb);
        out.push(nb);
      }
    }
    let filtered = out;
    if (typeFilter === "errors") filtered = filtered.filter((b) => (b.t === "tool_end" && !b.ok) || b.t === "notice");
    else if (typeFilter !== "all") filtered = filtered.filter((b) => b.t === typeFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      filtered = filtered.filter((b) =>
        `${b.nodeId} ${b.text} ${b.name ?? ""} ${b.args ?? ""}`.toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [events, nodeId, typeFilter, query]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Timestamp of the last programmatic scroll — its scroll event arrives late,
  // often after new output has already grown the feed again. Without this guard
  // that late event computes "not at bottom" and wrongly kills follow mode.
  const programmaticUntil = useRef(0);

  const scrollToBottom = () => {
    const el = feedRef.current;
    if (!el) return;
    programmaticUntil.current = Date.now() + 250;
    el.scrollTop = el.scrollHeight;
    // Streaming text lands in bursts: correct again after layout settles, so a
    // line that arrived between DOM commit and paint can't leave a gap.
    requestAnimationFrame(() => {
      const el2 = feedRef.current;
      if (!el2) return;
      programmaticUntil.current = Date.now() + 250;
      el2.scrollTop = el2.scrollHeight;
    });
  };

  // NOTE: depend on the last block's identity, not just the count — streaming
  // grows the final block in place (count unchanged) while the buffer cap can
  // also drop old events, so neither signal alone covers follow mode.
  const lastBlock = blocks.length ? blocks[blocks.length - 1] : null;
  useEffect(() => {
    if (!paused && stick) scrollToBottom();
  }, [blocks.length, lastBlock, paused, stick]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    if (Date.now() < programmaticUntil.current) {
      // Echo of our own scrollTo — re-assert follow instead of measuring.
      setStick(true);
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setStick(atBottom);
    // Scrolling back to the bottom resumes a paused feed — standard log-follow.
    if (atBottom) setPaused(false);
  };

  // Upward wheel / touch drag is always the user grabbing control — never
  // programmatic. (Downward wheel is ignored: the scroll event confirms bottom.)
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      programmaticUntil.current = 0;
      setStick(false);
    }
  };
  const onTouchMove = () => {
    programmaticUntil.current = 0;
    setStick(false);
  };

  const jumpToBottom = () => {
    setPaused(false);
    setStick(true);
    scrollToBottom();
  };

  const copyAll = () => {
    const txt = blocks
      .map((b) => {
        const head = `[${fmtTimestamp(b.ts)}] [${b.nodeId}] ${TYPE_LABEL[b.t] ?? b.t}${b.name ? ` ${b.name}` : ""}`;
        const body = b.t === "tool" ? (b.args ?? "") : b.t === "usage" ? "" : b.text;
        return body ? `${head}\n${body}` : head;
      })
      .join("\n\n");
    navigator.clipboard?.writeText(txt).catch(() => {});
  };

  const stepRow = (id: string | null, label: string, status: string | null, count: number) => {
    const active = nodeId === id;
    return (
      <Box
        key={label}
        px={3}
        py={2}
        cursor="pointer"
        bg={active ? "#1b2130" : "transparent"}
        borderLeft="2px solid"
        borderLeftColor={active ? "#7aa2f7" : "transparent"}
        onClick={() => setNodeId(id)}
        _hover={{ bg: "#1b2130" }}
      >
        <Flex gap={2} alignItems="center">
          {status ? (
            <Box w="8px" h="8px" borderRadius="full" flexShrink={0} bg={DOT[status] ?? "#8b91a0"} />
          ) : (
            <Box w="8px" h="8px" borderRadius="full" flexShrink={0} bg="#7aa2f7" />
          )}
          <Text
            fontSize="11px"
            fontWeight={active ? 700 : 500}
            fontFamily="ui-monospace, monospace"
            color={active ? "#7aa2f7" : "#e4e4e7"}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            flex="1"
            minW={0}
          >
            {label}
          </Text>
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
            {count}
          </Text>
        </Flex>
        {status && (
          <Text fontSize="10px" color="muted" pl={4} fontFamily="system-ui, sans-serif">
            {titleCase(status)}
          </Text>
        )}
      </Box>
    );
  };

  return (
    <Flex>
      {/* steps sidebar — mirrors the Pipeline tab lanes */}
      <Box
        w="190px"
        flexShrink={0}
        borderRight="1px solid"
        borderColor="line"
        bg="#10131a"
        maxH={height}
        minH="200px"
        overflowY="auto"
        py={1}
      >
        <Text fontSize="10px" color="muted" px={3} py={1} fontFamily="system-ui, sans-serif">
          Steps · {nodes.length}
        </Text>
        {stepRow(null, "All Nodes", null, events.length)}
        {nodes.map((n) => stepRow(n.id, n.id, n.status, countOf(n.id)))}
      </Box>

      <Box flex="1" minW={0} p={3}>
        <Flex gap={2} mb={2} flexWrap="wrap" alignItems="center">
          <SelectEl
            css={{ fontSize: "12px", bg: "surface2", color: "ink", border: "1px solid", borderColor: "line", borderRadius: "6px", px: "2", py: "1", width: "130px" }}
            value={typeFilter}
            onChange={(e) => setTypeFilter((e.target as HTMLSelectElement).value)}
            aria-label="type filter"
          >
            <option value="all">All Types</option>
            <option value="text">Text</option>
            <option value="think">Thinking</option>
            <option value="tool">Tool Calls</option>
            <option value="tool_end">Tool Results</option>
            <option value="errors">Errors ⚠</option>
            <option value="usage">Usage</option>
            <option value="notice">Notices</option>
          </SelectEl>
          <Input
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
            placeholder="Search…"
            size="xs"
            maxW="200px"
            bg="surface2"
            borderColor="line"
            color="ink"
            _placeholder={{ color: "#8b91a0" }}
          />
          <OutlineButton size="xs" active={paused || !stick} onClick={() => { if (paused || !stick) jumpToBottom(); else setPaused(true); }}>
            {paused || !stick ? "▶ Follow" : "⏸ Pause"}
          </OutlineButton>
          <GhostButton onClick={copyAll}>
            Copy
          </GhostButton>
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
            {nodeId ?? "All Nodes"} · {blocks.length} / {events.length}
            {eventsTotal && eventsTotal > events.length &&
              ` · latest ${events.length.toLocaleString()} of ${eventsTotal.toLocaleString()} events`}
          </Text>
        </Flex>
        <Box position="relative">
        <Box
          ref={feedRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onTouchMove={onTouchMove}
          h={`calc(${height} - 52px)`}
          minH="160px"
          overflowY="auto"
          bg="#0b0d12"
          border="1px solid"
          borderColor="line"
          borderRadius="md"
          py={1}
          fontSize="12px"
          fontFamily="ui-monospace, monospace"
        >
          {blocks.length === 0 && (
            <Text color="#c9cdd8" px={2} py={1}>
              No events yet — try All Nodes / clear filters.
            </Text>
          )}
          {blocks.map((b) => {
            const open = expanded.has(b.key);
            const err = b.t === "tool_end" && !b.ok;
            const accent = err ? "#f16a6a" : (TYPE_COLOR[b.t] ?? "#8b91a0");
            const body = open ? bodyOf(b) : null;
            return (
              <Box key={b.key} borderBottom="1px solid rgba(255,255,255,0.045)">
                <Box
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggle(b.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(b.key);
                    }
                  }}
                  display="flex"
                  alignItems="center"
                  gap={2}
                  px={2}
                  py="3px"
                  cursor="pointer"
                  bg={open ? "#12151d" : "transparent"}
                  _hover={{ bg: "#12151d" }}
                  _focusVisible={{ outline: "1px solid #7aa2f7", outlineOffset: "-1px" }}
                >
                  <Text
                    as="span"
                    fontSize="10px"
                    color="#6b7280"
                    flexShrink={0}
                    transform={open ? "rotate(90deg)" : "none"}
                    transition="transform 120ms"
                    lineHeight="1"
                  >
                    ▸
                  </Text>
                  <Text
                    as="span"
                    fontSize="9px"
                    fontWeight={700}
                    letterSpacing="0.08em"
                    textTransform="uppercase"
                    fontFamily="ui-monospace, monospace"
                    color={accent}
                    w="92px"
                    flexShrink={0}
                  >
                    {TYPE_LABEL[b.t] ?? b.t}
                  </Text>
                  {nodeId === null && (
                    <Text
                      as="span"
                      fontSize="9px"
                      color="#5b6272"
                      fontFamily="ui-monospace, monospace"
                      flexShrink={0}
                    >
                      {b.nodeId}
                    </Text>
                  )}
                  <Text
                    as="span"
                    fontSize="12px"
                    fontFamily="ui-monospace, monospace"
                    color={b.t === "think" ? "#8b91a0" : err ? "#f16a6a" : "#d7dae2"}
                    fontStyle={b.t === "think" ? "italic" : "normal"}
                    flex="1"
                    minW={0}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {previewOf(b)}
                  </Text>
                  <Text
                    as="span"
                    fontSize="10px"
                    color="#5b6272"
                    fontFamily="ui-monospace, monospace"
                    flexShrink={0}
                  >
                    {fmtTimestamp(b.ts)}
                  </Text>
                </Box>
                {body && (
                  <Box
                    px={2}
                    pb={2}
                    pl="30px"
                    fontSize="12px"
                    lineHeight="1.55"
                    fontFamily="ui-monospace, monospace"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                    color={
                      b.t === "think"
                        ? "#8b91a0"
                        : b.t === "tool"
                          ? "#9ca3af"
                          : b.t === "notice"
                            ? "#f0b429"
                            : err
                              ? "#f16a6a"
                              : "#c9cdd8"
                    }
                    fontStyle={b.t === "think" ? "italic" : "normal"}
                  >
                    {body.text}
                    {body.truncated && (
                      <Text as="span" display="block" mt={1} fontSize="9px" color="#f0b429">
                        output truncated at {BODY_CAP.toLocaleString()} chars
                      </Text>
                    )}
                    {b.count > 1 && (
                      <Text as="span" display="block" mt={1} fontSize="9px" color="#5b6272" fontStyle="normal">
                        {b.count} streamed fragments merged
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
        {(!stick || paused) && blocks.length > 0 && (
          <Box
            as="button"
            position="absolute"
            bottom={2}
            left="50%"
            transform="translateX(-50%)"
            bg="#2f6fed"
            color="white"
            fontSize="11px"
            fontFamily="system-ui, sans-serif"
            px={3}
            py={1}
            borderRadius="full"
            onClick={jumpToBottom}
            boxShadow="0 4px 16px rgba(0,0,0,0.5)"
          >
            ↓ Latest
          </Box>
        )}
        </Box>
      </Box>
    </Flex>
  );
}
