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

  return (
    <Box>
      <Flex gap={2} mb={2} flexWrap="wrap" alignItems="center">
        <SelectEl
          css={{ fontSize: "12px", bg: "surface2", color: "ink", border: "1px solid", borderColor: "line", borderRadius: "6px", px: "2", py: "1", maxW: "220px" }}
          value={nodeId ?? "__all"}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setNodeId(v === "__all" ? null : v);
          }}
          aria-label="node filter"
        >
          <option value="__all">All Nodes ({events.length})</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({events.filter((e) => e.nodeId === n.id).length})
            </option>
          ))}
        </SelectEl>
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
          {shown.length} / {events.length}
        </Text>
      </Flex>
      <Box
        ref={feedRef}
        h={height}
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
  );
}
