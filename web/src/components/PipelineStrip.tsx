import { Box, HStack, Text } from "@chakra-ui/react";
import { SelectEl } from "../ui/controls";
import { fmtDuration, roleOf } from "../lib/format";
import type { ModelInfo, NodeState, RunState } from "../api";

const DOT: Record<string, string> = {
  queued: "#8b91a0",
  running: "#7aa2f7",
  done: "#4fd6a8",
  failed: "#f16a6a",
  cancelled: "#8b91a0",
};

/** Connected node stepper — running nodes pulse, each card shows its live or
 *  final duration and (while it can still run or re-run) its model picker. */
export default function PipelineStrip({
  state,
  models,
  now,
  selectedNode,
  setSelectedNode,
  onNodeModel,
}: {
  state: RunState;
  models: ModelInfo[];
  now: number;
  selectedNode: string | null;
  setSelectedNode: (id: string) => void;
  onNodeModel: (nodeId: string, model: string) => void;
}) {
  const effective = (id: string) => state.nodeModels?.[id] ?? state.models[roleOf(id)] ?? "auto";
  const pickerDisabled = (n: NodeState) =>
    n.status === "done" && (n.id === "plan" || n.id === "clarify" || n.id === "verify");

  return (
    <HStack gap={1} flexWrap="wrap" alignItems="stretch">
      {state.nodes.map((n, i) => {
        const color = DOT[n.status] ?? "#8b91a0";
        const dur =
          n.status === "running" && n.startedAt
            ? fmtDuration(now - n.startedAt)
            : fmtDuration(n.durationMs);
        return (
          <HStack key={n.id} gap={1} alignItems="stretch">
            {i > 0 && (
              <Box display="flex" alignItems="center" px={1} color="muted" fontSize="lg">
                →
              </Box>
            )}
            <Box
              border="1px solid"
              borderColor={selectedNode === n.id ? "accent" : "line"}
              bg={selectedNode === n.id ? "surface2" : "surface"}
              borderRadius="md"
              p={2}
              minWidth="150px"
              cursor="pointer"
              onClick={() => setSelectedNode(n.id)}
            >
              <HStack gap={2} alignItems="center" mb={1}>
                <Box
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg={color}
                  animation={n.status === "running" ? "ncPulse 1.6s infinite" : undefined}
                />
                <Text fontSize="12px" fontWeight="bold" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                  {n.id}
                </Text>
              </HStack>
              <Text fontSize="10px" color="muted">
                {n.status === "running" && n.startedAt
                  ? `⏱ ${fmtDuration(now - n.startedAt)}`
                  : `took ${fmtDuration(n.durationMs)}`}
                {n.retries > 0 ? ` · retried ${n.retries}×` : ""}
              </Text>
              {live(n.status) && models.length > 0 && (
                <SelectEl
                  value={state.nodeModels?.[n.id] ?? "auto"}
                  css={{
                    width: "100%",
                    fontSize: "10px",
                    mt: "4px",
                    bg: "surface2",
                    color: "ink",
                    border: "1px solid",
                    borderColor: "line",
                    borderRadius: "4px",
                    py: "2px",
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onNodeModel(n.id, e.target.value)}
                >
                  <option value="auto">auto</option>
                  {models.map((m) => (
                    <option key={m.label} value={m.label}>
                      {m.label}
                    </option>
                  ))}
                </SelectEl>
              )}
            </Box>
          </HStack>
        );
      })}
    </HStack>
  );
}

function live(status: string): boolean {
  return status === "running" || status === "queued";
}
