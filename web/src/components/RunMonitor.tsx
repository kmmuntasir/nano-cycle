import { Box, Button, HStack, Stack, Text } from "@chakra-ui/react";
import Console from "./Console";
import GatePanel from "./GatePanel";
import PipelineStrip from "./PipelineStrip";
import StatsStrip from "./StatsStrip";
import Workbench from "./Workbench";
import type { ModelInfo, RunEvent, RunState } from "../api";

export default function RunMonitor({
  state,
  events,
  models,
  now,
  selectedNode,
  setSelectedNode,
  answerDrafts,
  setAnswerDrafts,
  onAnswers,
  onGate,
  onNodeModel,
  onCancel,
}: {
  state: RunState;
  events: RunEvent[];
  models: ModelInfo[];
  now: number;
  selectedNode: string | null;
  setSelectedNode: (id: string) => void;
  answerDrafts: Record<string, string>;
  setAnswerDrafts: (d: Record<string, string>) => void;
  onAnswers: (answers: Record<string, string>) => void;
  onGate: (action: "approve" | "cancel") => void;
  onNodeModel: (nodeId: string, model: string) => void;
  onCancel: () => void;
}) {
  const start = Date.parse(state.createdAt) || 0;
  const wall = Math.max(0, (state.finishedAt ?? now) - start);
  const gateLive =
    (state.status === "awaiting-gate" || state.status === "awaiting-answers") && state.gateSince;
  const gateMs =
    (state.gateWaitMs ?? 0) + (gateLive && state.gateSince ? Math.max(0, now - state.gateSince) : 0);
  const work = Math.max(0, wall - gateMs);

  return (
    <Stack gap={3}>
      <StatsStrip state={state} wall={wall} work={work} gateMs={gateMs} />

      <Box border="1px solid" borderColor="line" borderRadius="md" p={3} bg="surface">
        <Text fontSize="10px" color="muted" mb={1}>
          ORIGINAL TASK
        </Text>
        <Text fontSize="13px">{state.task}</Text>
      </Box>

      <GatePanel
        state={state}
        answerDrafts={answerDrafts}
        setAnswerDrafts={setAnswerDrafts}
        onAnswers={onAnswers}
        onGate={onGate}
      />

      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          pipeline
        </Text>
        <PipelineStrip
          state={state}
          models={models}
          now={now}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          onNodeModel={onNodeModel}
        />
      </Box>

      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          console — {selectedNode ?? "select a node"}
        </Text>
        <Console events={events} nodeId={selectedNode} />
      </Box>

      <Workbench state={state} />

      {(state.status === "running" ||
        state.status === "awaiting-gate" ||
        state.status === "awaiting-answers") && (
        <Button
          size="sm"
          variant="outline"
          colorPalette="red"
          onClick={onCancel}
          alignSelf="flex-start"
        >
          Cancel run
        </Button>
      )}
    </Stack>
  );
}
