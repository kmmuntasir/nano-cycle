import { Badge, HStack } from "@chakra-ui/react";
import { fmtDuration, fmtTokens } from "../lib/format";
import type { RunState } from "../api";

const STATUS_COLOR: Record<string, string> = {
  running: "blue",
  completed: "green",
  done: "green",
  "awaiting-gate": "yellow",
  "awaiting-answers": "yellow",
  failed: "red",
  cancelled: "gray",
  interrupted: "red",
};

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  running: "info",
  completed: "success",
  done: "success",
  "awaiting-gate": "warning",
  "awaiting-answers": "warning",
  failed: "error",
  cancelled: "neutral",
  interrupted: "error",
};

export default function StatsStrip({
  state,
  wall,
  work,
  gateMs,
}: {
  state: RunState;
  wall: number;
  work: number;
  gateMs: number;
}) {
  const totalUsage = state.nodes.reduce(
    (acc, n) => ({ input: acc.input + n.usage.input, output: acc.output + n.usage.output }),
    { input: 0, output: 0 },
  );
  return (
    <HStack flexWrap="wrap" gap={2}>
      <Badge
        colorPalette={STATUS_COLOR[state.status] === "info" ? "blue" : (STATUS_COLOR[state.status] as never) || "gray"}
        variant="subtle"
        px={2}
      >
        {state.status}
      </Badge>
      <Badge variant="outline" px={2}>
        ⏱ total {fmtDuration(wall)}
      </Badge>
      <Badge variant="outline" px={2}>
        working {fmtDuration(work)}
      </Badge>
      {gateMs > 0 && (
        <Badge variant="outline" px={2}>
          waited {fmtDuration(gateMs)}
        </Badge>
      )}
      <Badge variant="outline" px={2}>
        tokens ▲{fmtTokens(totalUsage.input)} ▼{fmtTokens(totalUsage.output)}
      </Badge>
      {state.git?.enabled && (
        <Badge
          variant="outline"
          px={2}
          colorPalette={state.git.merged ? "green" : "gray"}
        >
          ⎇ {state.git.runBranch} → {state.git.baseBranch}
          {state.git.merged ? " (merged)" : ` · ${state.git.commits.length} commit(s)`}
        </Badge>
      )}
      {state.git?.mergeError && (
        <Badge colorPalette="red" variant="subtle" px={2}>
          merge failed — branch kept
        </Badge>
      )}
    </HStack>
  );
}
