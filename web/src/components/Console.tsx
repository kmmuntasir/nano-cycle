import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Input, Text } from "@chakra-ui/react";
import { ArrowDown, ChevronRight, Pause, Play } from "lucide-react";
import { SelectEl } from "../ui/controls";
import { GhostButton, OutlineButton } from "../ui/buttons";
import { fmtTimestamp, fmtTokens } from "../lib/format";
import { buildBlocks, countByNode, filterBlocks } from "../lib/console-blocks";
import type { Block } from "../lib/console-blocks";
import type { NodeState, RunEvent } from "../api";

const titleCase = (s: string) =>
  s
    .split(/[\s-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

const DOT: Record<string, string> = {
  queued: "muted",
  running: "accent",
  done: "good",
  failed: "bad",
  cancelled: "muted",
};

// Blocks (coalesced streamed bursts) are built by lib/console-blocks.ts; a
// collapsed block is a single row — arrow, type label, one-line preview,
// timestamp — and the full content only appears on expand.

const TYPE_LABEL: Record<string, string> = {
  text: "Text",
  think: "Thinking",
  tool: "Tool Call",
  tool_end: "Tool Result",
  usage: "Usage",
  notice: "Notice",
};

const TYPE_COLOR: Record<string, string> = {
  text: "good",
  think: "muted",
  tool: "accent",
  tool_end: "good",
  usage: "muted",
  notice: "warn",
};

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

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
  if (b.t === "tool_end") return `${b.ok ? "ok" : "ERR"} ${b.name ?? "tool"}${b.ok ? "" : " (error)"}`;
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
  nodes: NodeState[];
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

  // One pass instead of an events.filter per node per render.
  const nodeCounts = useMemo(() => countByNode(events), [events]);
  const countOf = (id: string) => nodeCounts.get(id) ?? 0;

  // Node filter + coalescing depends only on events/node; the type/search
  // filter runs on the built blocks — typing in the search box no longer
  // regroups thousands of events, and a streamed token only rebuilds when
  // `events` flushes (batched upstream).
  const grouped = useMemo(() => buildBlocks(events, nodeId), [events, nodeId]);
  const blocks = useMemo(() => filterBlocks(grouped, typeFilter, query), [grouped, typeFilter, query]);

  const toggle = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

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
        minH={{ base: "44px", md: "0" }}
        flexShrink={0}
        minW={{ base: "120px", md: 0 }}
        cursor="pointer"
        bg={active ? "surface2" : "transparent"}
        borderLeft={{ base: "none", md: "2px solid" }}
        borderLeftColor={active ? "accent" : "transparent"}
        borderBottom={{ base: "2px solid", md: "none" }}
        borderBottomColor={active ? "accent" : "transparent"}
        onClick={() => setNodeId(id)}
        _hover={{ bg: "surface2" }}
      >
        <Flex gap={2} alignItems="center">
          {status ? (
            <Box w="8px" h="8px" borderRadius="full" flexShrink={0} bg={DOT[status] ?? "muted"} />
          ) : (
            <Box w="8px" h="8px" borderRadius="full" flexShrink={0} bg="accent" />
          )}
          <Text
            fontSize="11px"
            fontWeight={active ? 700 : 500}
            fontFamily="ui-monospace, monospace"
            color={active ? "accent" : "ink"}
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
    <Flex flexDirection={{ base: "column", md: "row" }}>
      {/* steps sidebar — mirrors the Pipeline tab lanes; a scrolling chip strip on phones */}
      <Box
        w={{ base: "100%", md: "190px" }}
        flexShrink={0}
        display={{ base: "flex", md: "block" }}
        borderRight={{ base: "none", md: "1px solid" }}
        borderBottom={{ base: "1px solid", md: "none" }}
        borderColor="line"
        bg="chatPanel"
        maxH={{ base: "none", md: height }}
        minH={{ base: "0", md: "200px" }}
        overflowY={{ base: "hidden", md: "auto" }}
        overflowX={{ base: "auto", md: "hidden" }}
        css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
        py={1}
      >
        <Text display={{ base: "none", md: "block" }} fontSize="10px" color="muted" px={3} py={1} fontFamily="system-ui, sans-serif">
          Steps · {nodes.length}
        </Text>
        {stepRow(null, "All Nodes", null, events.length)}
        {nodes.map((n) => stepRow(n.id, n.id, n.status, countOf(n.id)))}
      </Box>

      <Box flex="1" minW={0} p={3}>
        <Flex gap={2} mb={2} flexWrap="wrap" alignItems="center">
          <SelectEl
            minH={{ base: "40px", md: "0" }}
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
            <option value="errors">Errors only</option>
            <option value="usage">Usage</option>
            <option value="notice">Notices</option>
          </SelectEl>
          <Input
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
            placeholder="Search…"
            size="xs"
            minH={{ base: "40px", md: "0" }}
            flex={{ base: "1 1 120px", md: "none" }}
            maxW="200px"
            bg="surface2"
            borderColor="line"
            color="ink"
            _placeholder={{ color: "muted" }}
          />
          <OutlineButton size="xs" active={paused || !stick} onClick={() => { if (paused || !stick) jumpToBottom(); else setPaused(true); }}>
            <Box as="span" display="inline-flex" alignItems="center" gap={1}>
              {paused || !stick ? <Play size={12} /> : <Pause size={12} />}
              {paused || !stick ? "Follow" : "Pause"}
            </Box>
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
          bg="chatCode"
          border="1px solid"
          borderColor="line"
          borderRadius="md"
          py={1}
          fontSize="12px"
          fontFamily="ui-monospace, monospace"
        >
          {blocks.length === 0 && (
            <Text color="ink" px={2} py={1}>
              No events yet — try All Nodes / clear filters.
            </Text>
          )}
          {blocks.map((b) => (
            <BlockRow key={b.key} b={b} open={expanded.has(b.key)} showNode={nodeId === null} onToggle={toggle} />
          ))}
        </Box>
        {(!stick || paused) && blocks.length > 0 && (
          <Box
            as="button"
            position="absolute"
            bottom={2}
            left="50%"
            transform="translateX(-50%)"
            bg="accent"
            color="onAccent"
            fontSize="11px"
            fontFamily="system-ui, sans-serif"
            px={3}
            py={1}
            borderRadius="full"
            onClick={jumpToBottom}
            boxShadow="0 4px 16px rgba(0,0,0,0.5)"
            display="inline-flex"
            alignItems="center"
            gap={1}
          >
            <ArrowDown size={12} /> Latest
          </Box>
        )}
        </Box>
      </Box>
    </Flex>
  );
}

// One console row. Memoised on block identity-by-content: a regroup after each
// flush creates new Block objects, but only the rows whose key / fragment
// count / text length / expansion actually changed re-render.
const BlockRow = memo(
  function BlockRow({ b, open, showNode, onToggle }: { b: Block; open: boolean; showNode: boolean; onToggle: (key: string) => void }) {
    const err = b.t === "tool_end" && !b.ok;
    const accent = err ? "bad" : (TYPE_COLOR[b.t] ?? "muted");
    const body = open ? bodyOf(b) : null;
    return (
      <Box borderBottom="1px solid rgba(255,255,255,0.045)">
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => onToggle(b.key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle(b.key);
            }
          }}
          display="flex"
          alignItems="center"
          gap={2}
          px={2}
          py="3px"
          minH={{ base: "40px", md: "0" }}
          cursor="pointer"
          bg={open ? "surface2" : "transparent"}
          _hover={{ bg: "surface2" }}
          _focusVisible={{ outline: "1px solid var(--chakra-colors-accent)", outlineOffset: "-1px" }}
        >
          <Box
            as="span"
            fontSize="10px"
            color="muted"
            flexShrink={0}
            transform={open ? "rotate(90deg)" : "none"}
            transition="transform 120ms"
            lineHeight="1"
            display="inline-flex"
          >
            <ChevronRight size={12} />
          </Box>
          <Text
            as="span"
            fontSize="9px"
            fontWeight={700}
            letterSpacing="0.08em"
            textTransform="uppercase"
            fontFamily="ui-monospace, monospace"
            color={accent}
            w={{ base: "62px", md: "92px" }}
            flexShrink={0}
          >
            {TYPE_LABEL[b.t] ?? b.t}
          </Text>
          {showNode && (
            <Text
              as="span"
              display={{ base: "none", sm: "inline" }}
              fontSize="9px"
              color="muted"
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
            color={b.t === "think" ? "muted" : err ? "bad" : "ink"}
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
            display={{ base: "none", sm: "inline" }}
            fontSize="10px"
            color="muted"
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
            pl={{ base: 2, md: "30px" }}
            fontSize="12px"
            lineHeight="1.55"
            fontFamily="ui-monospace, monospace"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            color={
              b.t === "think"
                ? "muted"
                : b.t === "tool"
                  ? "muted"
                  : b.t === "notice"
                    ? "warn"
                    : err
                      ? "bad"
                      : "ink"
            }
            fontStyle={b.t === "think" ? "italic" : "normal"}
          >
            <Text as="span" display={{ base: "block", sm: "none" }} fontSize="9px" color="muted" mb={1}>
              {b.nodeId} · {fmtTimestamp(b.ts)}
            </Text>
            {body.text}
            {body.truncated && (
              <Text as="span" display="block" mt={1} fontSize="9px" color="warn">
                output truncated at {BODY_CAP.toLocaleString()} chars
              </Text>
            )}
            {b.count > 1 && (
              <Text as="span" display="block" mt={1} fontSize="9px" color="muted" fontStyle="normal">
                {b.count} streamed fragments merged
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  },
  (p, n) =>
    p.open === n.open &&
    p.showNode === n.showNode &&
    p.onToggle === n.onToggle &&
    p.b.key === n.b.key &&
    p.b.count === n.b.count &&
    p.b.text.length === n.b.text.length,
);
