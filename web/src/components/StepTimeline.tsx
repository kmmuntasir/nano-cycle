import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import ModelPicker from "../ui/ModelPicker";
import { fmtDuration } from "../lib/format";
import { isV2, orderedUnits } from "../lib/pipeline";
import type { ModelInfo, NodeState, RunState } from "../api";

const DOT: Record<string, string> = {
  queued: "#8b91a0",
  running: "#7aa2f7",
  done: "#4fd6a8",
  failed: "#f16a6a",
  cancelled: "#8b91a0",
};

const STEP_META: Record<string, { title: string; hint: string; role: string }> = {
  clarify: { title: "Clarify", hint: "PM question loop", role: "clarify" },
  build: { title: "Build", hint: "plan → tasks → implement (one session)", role: "builder" },
  verify: { title: "Verify", hint: "verify code → audit deliverables", role: "verifier" },
  security: { title: "Security", hint: "scanner triage (+ VAPT)", role: "security" },
};

const titleCase = (s: string) =>
  s
    .split(/[\s-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");

function StepCard({
  n,
  now,
  selected,
  onSelect,
  models,
  modelValue,
  onModelPick,
  detail,
  disabledModel,
}: {
  n: NodeState;
  now: number;
  selected: boolean;
  onSelect: () => void;
  models: ModelInfo[];
  modelValue: string;
  onModelPick: (model: string) => void;
  detail?: string;
  disabledModel?: boolean;
}) {
  const color = DOT[n.status] ?? "#8b91a0";
  return (
    <Box
      border="1px solid"
      borderColor={selected ? "accent" : "line"}
      bg={selected ? "surface2" : "#10131a"}
      borderRadius="md"
      p={3}
      minW="190px"
      flex="1"
      cursor="pointer"
      onClick={onSelect}
    >
      <HStack gap={2} alignItems="center" mb={1}>
        <Box
          w="9px"
          h="9px"
          borderRadius="full"
          bg={color}
          flexShrink={0}
          animation={n.status === "running" ? "ncPulse 1.6s infinite" : undefined}
        />
        <Text fontSize="13px" fontWeight={800} fontFamily="ui-monospace, monospace">
          {STEP_META[n.id]?.title ?? titleCase(n.id)}
        </Text>
      </HStack>
      <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
        {titleCase(n.status)}
        {" · "}
        {n.status === "running" && n.startedAt ? `⏱ ${fmtDuration(now - n.startedAt)}` : fmtDuration(n.durationMs)}
        {n.retries > 0 ? ` · ↻${n.retries}` : ""}
      </Text>
      {(detail || STEP_META[n.id]?.hint) && (
        <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif">
          {detail ?? STEP_META[n.id]?.hint}
        </Text>
      )}
      {n.error && (
        <Text fontSize="10px" color="#f16a6a" mt={1} fontFamily="system-ui, sans-serif">
          {n.error.slice(0, 140)}
        </Text>
      )}
      {n.status !== "done" && models.length > 0 && (
        <Box mt="6px" onClick={(e) => e.stopPropagation()} opacity={disabledModel ? 0.5 : 1} pointerEvents={disabledModel ? "none" : "auto"}>
          <ModelPicker
            value={modelValue}
            models={models}
            onChange={onModelPick}
            compact
            ariaLabel={`model for ${n.id}`}
          />
        </Box>
      )}
    </Box>
  );
}

/** v2 step timeline (four steps + fix-round counters). Legacy v1 runs render
 *  their node list through the same cards. */
export default function StepTimeline({
  state,
  models,
  now,
  selectedNode,
  setSelectedNode,
  onStepModel,
  onViewLogs,
}: {
  state: RunState;
  models: ModelInfo[];
  now: number;
  selectedNode: string | null;
  setSelectedNode: (id: string) => void;
  onStepModel: (stepId: string, model: string) => void;
  onViewLogs: (id: string) => void;
}) {
  const units = orderedUnits(state);
  const v2 = isV2(state);
  const modelValue = (id: string) => state.models?.[STEP_META[id]?.role ?? id] ?? "auto";

  const detailOf = (n: NodeState): string | undefined => {
    if (!v2) return undefined;
    if (n.id === "build" && (n.rounds ?? 0) > 0) return `fix rounds: ${n.rounds} — session resumed per round`;
    if (n.id === "verify" && (state.round ?? 0) > 0) return `verification round ${(state.round ?? 0) + (n.status === "running" ? 0 : 1)}`;
    if (n.id === "security" && state.options?.security === "scan+vapt") return "scanner triage + VAPT";
    return undefined;
  };

  return (
    <Stack gap={3}>
      {v2 && (
        <Text fontSize="10px" color="muted" letterSpacing="widest" fontFamily="system-ui, sans-serif">
          FOUR-STEP WORKFLOW · FIX LOOPS RESUME THE BUILD SESSION
        </Text>
      )}
      <Flex gap={2} flexWrap="wrap" alignItems="stretch">
        {units.map((n) => (
          <StepCard
            key={n.id}
            n={n}
            now={now}
            selected={selectedNode === n.id}
            onSelect={() => setSelectedNode(n.id)}
            models={models}
            modelValue={modelValue(n.id)}
            onModelPick={(m) => onStepModel(n.id, m)}
            detail={detailOf(n)}
            disabledModel={n.status === "running"}
          />
        ))}
      </Flex>
      {selectedNode && units.find((u) => u.id === selectedNode) && (
        <Box border="1px solid" borderColor="line" borderRadius="md" p={2} bg="surface">
          <Flex gap={2} alignItems="center" flexWrap="wrap">
            <Text fontSize="11px" fontFamily="ui-monospace, monospace">
              {selectedNode}
            </Text>
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              {units.find((u) => u.id === selectedNode)?.status} · tokens ▲
              {units.find((u) => u.id === selectedNode)?.usage.input ?? 0} ▼
              {units.find((u) => u.id === selectedNode)?.usage.output ?? 0}
              {units.find((u) => u.id === selectedNode)?.usage.cacheRead ? ` ♻${units.find((u) => u.id === selectedNode)?.usage.cacheRead}` : ""}
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
      {!v2 && units.length === 0 && (
        <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
          (legacy run — no node data)
        </Text>
      )}
    </Stack>
  );
}
