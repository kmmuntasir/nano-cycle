import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { RunEvent } from "../api";

const fmtTimestamp = (ms: number): string => {
  const d = new Date(ms || Date.now());
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export default function EventFeed({
  events,
  nodeId,
  height = "48vh",
}: {
  events: RunEvent[];
  nodeId: string | null;
  height?: string;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const shown = useMemoFilter(events, nodeId);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [shown.length]);

  return (
    <Paper
      ref={feedRef}
      variant="outlined"
      sx={{
        p: 1.5,
        height,
        overflowY: "auto",
        bgcolor: "#0d0d0d",
        fontFamily: "monospace",
        fontSize: 13,
      }}
    >
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {nodeId ? "No events yet for this node." : "Select a node."}
        </Typography>
      )}
      {shown.map((e, i) => {
        const ev = e.ev;
        const stamp = `[${fmtTimestamp(e.ts ?? (ev as { ts?: number }).ts ?? 0)}] `;
        if (ev.t === "text") {
          const burstStart = i === 0 || shown[i - 1].ev.t !== "text";
          return (
            <span key={i}>
              {burstStart && <span style={{ color: "#6aa84f" }}>{stamp}</span>}
              {ev.s}
            </span>
          );
        }
        if (ev.t === "think")
          return (
            <span key={i} style={{ color: "#777", fontStyle: "italic" }}>
              {ev.s}
            </span>
          );
        if (ev.t === "tool")
          return (
            <div key={i} style={{ color: "#90caf9", margin: "4px 0" }}>
              {stamp}▸ {ev.name} {ev.args}
            </div>
          );
        if (ev.t === "tool_end")
          return (
            <div key={i} style={{ color: ev.ok ? "#66bb6a" : "#ef5350" }}>
              {stamp}✔ {ev.name} {ev.ok ? "" : "(error)"}
            </div>
          );
        if (ev.t === "usage")
          return (
            <div key={i} style={{ color: "#888" }}>
              {stamp}⏱ tokens in {ev.usage?.input} / out {ev.usage?.output}
            </div>
          );
        if (ev.t === "notice")
          return (
            <div key={i} style={{ color: "#ffa726", margin: "4px 0" }}>
              {stamp}⚠ {ev.s}
            </div>
          );
        return null;
      })}
    </Paper>
  );
}

function useMemoFilter(events: RunEvent[], nodeId: string | null): RunEvent[] {
  const ref = useRef<{ key: string; value: RunEvent[] }>({ key: "", value: [] });
  const key = `${nodeId ?? ""}:${events.length}`;
  if (ref.current.key !== key) {
    ref.current = {
      key,
      value: nodeId ? events.filter((e) => e.nodeId === nodeId) : events,
    };
  }
  return ref.current.value;
}
