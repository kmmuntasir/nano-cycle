import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Input, Text } from "@chakra-ui/react";
import { SelectEl } from "../ui/controls";
import { GhostButton, OutlineButton } from "../ui/buttons";
import type { RunEvent, RunState } from "../api";

function rel(ts: number, start: number): string {
  const d = Math.max(0, ts - start);
  const s = Math.floor(d / 1000);
  if (s < 60) return `+${s}s`;
  return `+${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

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

export default function Console({
  events,
  nodes,
  nodeId,
  setNodeId,
  height = "52vh",
  runStart,
}: {
  events: RunEvent[];
  nodes: RunState["nodes"];
  nodeId: string | null;
  setNodeId: (id: string | null) => void;
  height?: string;
  runStart: number;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);

  const countOf = (id: string) => events.filter((e) => e.nodeId === id).length;

  const shown = useMemo(() => {
    let list = nodeId ? events.filter((e) => e.nodeId === nodeId) : events;
    if (typeFilter === "errors") list = list.filter((e) => e.ev.t === "tool_end" && !e.ev.ok || e.ev.t === "notice");
    else if (typeFilter !== "all") list = list.filter((e) => e.ev.t === typeFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((e) =>
        `${e.nodeId} ${e.ev.s ?? ""} ${e.ev.name ?? ""} ${e.ev.args ?? ""}`.toLowerCase().includes(q),
      );
    }
    return list;
  }, [events, nodeId, typeFilter, query]);

  useEffect(() => {
    if (!paused) feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [shown.length, paused]);

  const copyAll = () => {
    const txt = shown.map((e) => `[${e.nodeId}] ${e.ev.s ?? e.ev.name ?? e.ev.t} ${e.ev.args ?? ""}`).join("\n");
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
          <OutlineButton size="xs" active={paused} onClick={() => setPaused((v) => !v)}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </OutlineButton>
          <GhostButton onClick={copyAll}>
            Copy
          </GhostButton>
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
            {nodeId ?? "All Nodes"} · {shown.length} / {events.length}
          </Text>
        </Flex>
        <Box
          ref={feedRef}
          h={`calc(${height} - 52px)`}
          minH="160px"
          overflowY="auto"
          bg="#0b0d12"
          border="1px solid"
          borderColor="line"
          borderRadius="md"
          p={2}
          fontSize="12px"
          lineHeight="1.5"
          fontFamily="ui-monospace, monospace"
        >
          {shown.length === 0 && <Text color="#c9cdd8">No events yet — try All Nodes / clear filters.</Text>}
          {shown.map((e, i) => {
            const ev = e.ev;
            if (ev.t === "text") {
              const burst = i === 0 || shown[i - 1].ev.t !== "text" || shown[i - 1].nodeId !== e.nodeId;
              return (
                <span key={i}>
                  {burst && (
                    <span style={{ color: "#4fd6a8" }}>
                      [{rel(e.ts, runStart)} {nodeId ? "" : `${e.nodeId} `}]
                    </span>
                  )}
                  {ev.s}
                </span>
              );
            }
            if (ev.t === "think")
              return (
                <span key={i} style={{ color: "#6b7280", fontStyle: "italic" }}>
                  {ev.s}
                </span>
              );
            if (ev.t === "tool")
              return (
                <div key={i} style={{ color: "#7aa2f7", margin: "3px 0", wordBreak: "break-word" }}>
                  <span style={{ color: "#4b5563" }}>{rel(e.ts, runStart)}</span> ▸ [{e.nodeId}] {ev.name}{" "}
                  <span style={{ color: "#9ca3af" }}>{(ev.args ?? "").slice(0, 300)}</span>
                </div>
              );
            if (ev.t === "tool_end")
              return (
                <div key={i} style={{ color: ev.ok ? "#4fd6a8" : "#f16a6a", borderLeft: ev.ok ? undefined : "2px solid #f16a6a", paddingLeft: ev.ok ? 0 : 6 }}>
                  <span style={{ color: "#4b5563" }}>{rel(e.ts, runStart)}</span> {ev.ok ? "✔" : "✘"} [{e.nodeId}] {ev.name} {ev.ok ? "" : "(error)"}
                </div>
              );
            if (ev.t === "usage")
              return (
                <div key={i} style={{ color: "#8b91a0" }}>
                  {rel(e.ts, runStart)} [{e.nodeId}] tokens ▲{ev.usage?.input} ▼{ev.usage?.output}
                </div>
              );
            if (ev.t === "notice")
              return (
                <div key={i} style={{ color: "#f0b429", margin: "3px 0" }}>
                  {rel(e.ts, runStart)} [{e.nodeId}] ⚠ {ev.s}
                </div>
              );
            return null;
          })}
        </Box>
      </Box>
    </Flex>
  );
}
