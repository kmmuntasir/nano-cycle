import { useEffect, useRef } from "react";
import { Box, Text } from "@chakra-ui/react";
import { fmtTimestamp } from "../lib/format";
import type { RunEvent } from "../api";

export default function Console({
  events,
  nodeId,
  height = "46vh",
}: {
  events: RunEvent[];
  nodeId: string | null;
  height?: string;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const shown = nodeId ? events.filter((e) => e.nodeId === nodeId) : events;
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [shown.length]);

  return (
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
    >
      {shown.length === 0 && <Text color="muted">No events yet.</Text>}
      {shown.map((e, i) => {
        const ev = e.ev;
        const stamp = fmtTimestamp(e.ts);
        if (ev.t === "text") {
          const burst = i === 0 || shown[i - 1].ev.t !== "text";
          return (
            <span key={i}>
              {burst && <span style={{ color: "#4fd6a8" }}>[{stamp}] </span>}
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
            <div key={i} style={{ color: "#7aa2f7", margin: "3px 0" }}>
              [{stamp}] ▸ {ev.name} {ev.args}
            </div>
          );
        if (ev.t === "tool_end")
          return (
            <div key={i} style={{ color: ev.ok ? "#4fd6a8" : "#f16a6a" }}>
              [{stamp}] ✔ {ev.name} {ev.ok ? "" : "(error)"}
            </div>
          );
        if (ev.t === "usage")
          return (
            <div key={i} style={{ color: "#8b91a0" }}>
              [{stamp}] tokens ▲{ev.usage?.input} ▼{ev.usage?.output}
            </div>
          );
        if (ev.t === "notice")
          return (
            <div key={i} style={{ color: "#f0b429", margin: "3px 0" }}>
              [{stamp}] ⚠ {ev.s}
            </div>
          );
        return null;
      })}
    </Box>
  );
}
