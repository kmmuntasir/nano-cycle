import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import ModelPicker from "../ui/ModelPicker";
import { fmtDuration, roleOf } from "../lib/format";
import type { ModelInfo, NodeState, RunState } from "../api";

const DOT: Record<string, string> = {
  queued: "#8b91a0",
  running: "#7aa2f7",
  done: "#4fd6a8",
  failed: "#f16a6a",
  cancelled: "#8b91a0",
};

const titleCase = (s: string) =>
  s
    .split(/[\s-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

function NodeCard({
  n,
  now,
  selected,
  onSelect,
  models,
  modelValue,
  onNodeModel,
  detail,
}: {
  n: NodeState;
  now: number;
  selected: boolean;
  onSelect: () => void;
  models: ModelInfo[];
  modelValue: string;
  onNodeModel: (nodeId: string, model: string) => void;
  detail?: string;
}) {
  const color = DOT[n.status] ?? "#8b91a0";
  return (
    <Box
      border="1px solid"
      borderColor={selected ? "accent" : "line"}
      bg={selected ? "surface2" : "#10131a"}
      borderRadius="md"
      p={2}
      minW="170px"
      maxW="230px"
      flex="1"
      cursor="pointer"
      onClick={onSelect}
    >
      <HStack gap={2} alignItems="center" mb={1}>
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={color}
          flexShrink={0}
          animation={n.status === "running" ? "ncPulse 1.6s infinite" : undefined}
        />
        <Text fontSize="12px" fontWeight={700} fontFamily="ui-monospace, monospace" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {n.id}
        </Text>
      </HStack>
      <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
        {titleCase(n.status)}
        {" · "}
        {n.status === "running" && n.startedAt ? `⏱ ${fmtDuration(now - n.startedAt)}` : `${fmtDuration(n.durationMs)}`}
        {n.retries > 0 ? ` · ↻${n.retries}` : ""}
      </Text>
      {detail && (
        <Text fontSize="10px" color="muted" mt={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" fontFamily="system-ui, sans-serif">
          {detail}
        </Text>
      )}
      {n.error && (
        <Text fontSize="10px" color="#f16a6a" mt={1} fontFamily="system-ui, sans-serif">
          {n.error.slice(0, 120)}
        </Text>
      )}
      {(n.status === "running" || n.status === "queued") && models.length > 0 && (
        <Box mt="6px" onClick={(e) => e.stopPropagation()}>
          <ModelPicker
            value={modelValue}
            models={models}
            onChange={(v) => onNodeModel(n.id, v)}
            compact
            ariaLabel={`model for ${n.id}`}
          />
        </Box>
      )}
    </Box>
  );
}

export default function PipelineLanes({
  state,
  models,
  now,
  selectedNode,
  setSelectedNode,
  onNodeModel,
  onViewLogs,
}: {
  state: RunState;
  models: ModelInfo[];
  now: number;
  selectedNode: string | null;
  setSelectedNode: (id: string) => void;
  onNodeModel: (nodeId: string, model: string) => void;
  onViewLogs: (id: string) => void;
}) {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const pick = (id: string) => byId.get(id);
  const coders = state.nodes.filter((n) => n.id.startsWith("impl"));
  const be = coders.filter((n) => roleOf(n.id) !== "frontend");
  const fe = coders.filter((n) => roleOf(n.id) === "frontend");
  const solo = state.nodes.filter((n) => !["clarify", "plan", "verify"].includes(n.id) && !n.id.startsWith("impl"));
  const clarify = pick("clarify");
  const plan = pick("plan");
  const verify = pick("verify");
  const modelValue = (id: string) => state.nodeModels?.[id] ?? "auto";

  const laneTitle = (t: string, count: number) => (
    <Text fontSize="10px" color="muted" letterSpacing="widest" mb={1} fontFamily="system-ui, sans-serif">
      {t}{count > 0 ? ` · ${count}` : ""}
    </Text>
  );

  const renderRow = (nodes: NodeState[], emptyHint: string, detailOf?: (id: string) => string | undefined) =>
    nodes.length === 0 ? (
      <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
        {emptyHint}
      </Text>
    ) : (
      <Flex gap={2} flexWrap="wrap">
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            n={n}
            now={now}
            selected={selectedNode === n.id}
            onSelect={() => {
              setSelectedNode(n.id);
            }}
            models={models}
            modelValue={modelValue(n.id)}
            onNodeModel={onNodeModel}
            detail={detailOf?.(n.id)}
          />
        ))}
      </Flex>
    );

  return (
    <Stack gap={3}>
      {clarify && (
        <Box>
          {laneTitle("Clarify", 1)}
          {renderRow([clarify], "")}
        </Box>
      )}
      {plan && (
        <Box>
          {laneTitle("Plan", 1)}
          {renderRow([plan], "")}
        </Box>
      )}
      {solo.length > 0 && (
        <Box>
          {laneTitle("Steps", solo.length)}
          {renderRow(solo, "")}
        </Box>
      )}
      <Flex gap={3} flexWrap="wrap">
        <Box flex="1" minW="240px">
          <Text fontSize="10px" color="muted" letterSpacing="widest" mb={1} fontFamily="system-ui, sans-serif">
            ◀ Backend · {be.length || "—"}
          </Text>
          {renderRow(be, "No Backend Coders")}
        </Box>
        <Box flex="1" minW="240px">
          <Text fontSize="10px" color="muted" letterSpacing="widest" mb={1} fontFamily="system-ui, sans-serif">
            Frontend ▶ · {fe.length || "—"}
          </Text>
          {renderRow(fe, "No Frontend Coders")}
        </Box>
      </Flex>
      {verify && (
        <Box>
          {laneTitle("Verify (Gate)", 1)}
          {renderRow([verify], "")}
        </Box>
      )}
      {selectedNode && byId.get(selectedNode) && (
        <Box border="1px solid" borderColor="line" borderRadius="md" p={2} bg="surface">
          <Flex gap={2} alignItems="center" flexWrap="wrap">
            <Text fontSize="11px" fontFamily="ui-monospace, monospace">
              {selectedNode}
            </Text>
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              {byId.get(selectedNode)?.status} · tokens ▲{byId.get(selectedNode)?.usage.input ?? 0} ▼
              {byId.get(selectedNode)?.usage.output ?? 0}
            </Text>
            <Box flex="1" />
            <Box
              as="button"
              fontSize="11px"
              color="accent"
              onClick={() => onViewLogs(selectedNode)}
              style={{ fontFamily: "system-ui, sans-serif" }}
            >
              View Logs →
            </Box>
          </Flex>
        </Box>
      )}
    </Stack>
  );
}
