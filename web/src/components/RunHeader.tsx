import { Badge, Box, Flex, HStack, Text } from "@chakra-ui/react";
import { DangerOutlineButton, PrimaryButton } from "../ui/buttons";
import { fmtDuration, fmtTokens } from "../lib/format";
import type { RunState } from "../api";

const STATUS_COLOR: Record<string, "blue" | "green" | "yellow" | "red" | "gray"> = {
  running: "blue",
  completed: "green",
  "awaiting-gate": "yellow",
  "awaiting-answers": "yellow",
  failed: "red",
  cancelled: "gray",
  interrupted: "red",
};

const titleCase = (s: string) =>
  s
    .split(/[\s-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

export default function RunHeader({
  state,
  wall,
  work,
  gateMs,
  live,
  onCancel,
  onResume,
}: {
  state: RunState;
  wall: number;
  work: number;
  gateMs: number;
  live: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const totalUsage = (state.steps ?? state.nodes ?? []).reduce(
    (acc, n) => ({ input: acc.input + n.usage.input, output: acc.output + n.usage.output }),
    { input: 0, output: 0 },
  );
  // The configuration this run started with — visible during AND after the run.
  const o = state.options;
  const chips: { label: string; on: boolean }[] = o
    ? [
        { label: o.clarify ? (o.requireQuestions ? "Clarify on · PM Must Ask" : "Clarify on") : "Clarify off", on: o.clarify },
        { label: `Security: ${o.security === "scan+vapt" ? "Scan+VAPT" : o.security === "scan" ? "Scan" : "Off"}`, on: o.security !== "off" },
        { label: o.git ? "Git on" : "Git off", on: o.git },
        { label: o.remoteCi ? "Remote CI on" : "Remote CI off", on: o.remoteCi },
        { label: o.audit ? "Audit on" : "Audit off", on: o.audit },
        { label: o.approvePlan ? "Plan Approval on" : "Plan Approval off", on: o.approvePlan },
        { label: `Fix Rounds: ${o.maxFixRounds}`, on: o.maxFixRounds > 0 },
      ]
    : [{ label: `tier ${state.tier ?? "legacy"}`, on: false }];
  return (
    <Box
      border="1px solid"
      borderColor="line"
      borderRadius="lg"
      bg="surface"
      p={4}
      position="sticky"
      top="60px"
      zIndex={10}
    >
      <Flex gap={3} alignItems="flex-start" flexWrap="wrap">
        <Box flex="1" minW="240px">
          <HStack gap={2} mb={1} flexWrap="wrap">
            <Badge colorPalette={STATUS_COLOR[state.status] ?? "gray"} variant="subtle">
              {titleCase(state.status.replace(/-/g, " "))}
            </Badge>
            <Text fontSize="12px" fontWeight={700} fontFamily="ui-monospace, monospace">
              {state.id}
            </Text>
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              {state.tier} · {state.project}
            </Text>
          </HStack>
          <Text fontSize="14px" fontWeight={600} fontFamily="system-ui, sans-serif" lineHeight="1.4">
            {state.task}
          </Text>
          <HStack gap={2} mt={2} flexWrap="wrap">
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              ⏱ {fmtDuration(wall)} total · {fmtDuration(work)} work
              {gateMs > 0 ? ` · waited ${fmtDuration(gateMs)}` : ""}
            </Text>
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              ▲{fmtTokens(totalUsage.input)} ▼{fmtTokens(totalUsage.output)}
            </Text>
            {state.git?.enabled && (
              <Text fontSize="11px" color={state.git.merged ? "#4fd6a8" : "muted"} fontFamily="ui-monospace, monospace">
                ⎇ {state.git.runBranch} → {state.git.baseBranch}
                {state.git.merged ? " (merged)" : ` · ${state.git.commits.length} commit(s)`}
              </Text>
            )}
            {state.git?.mergeError && (
              <Text fontSize="11px" color="#f16a6a" fontFamily="system-ui, sans-serif">
                Merge failed — branch kept.
              </Text>
            )}
            {state.error && (
              <Text fontSize="11px" color="#f16a6a" fontFamily="system-ui, sans-serif">
                {state.error}
              </Text>
            )}
          </HStack>
          <HStack gap={1.5} mt={2} flexWrap="wrap">
            {chips.map((c) => (
              <Box
                key={c.label}
                px={2}
                py={0.5}
                borderRadius="sm"
                border="1px solid"
                borderColor={c.on ? "#2b3a5c" : "line"}
                bg={c.on ? "#1b2130" : "transparent"}
              >
                <Text fontSize="10px" color={c.on ? "#7aa2f7" : "muted"} fontFamily="ui-monospace, monospace">
                  {c.label}
                </Text>
              </Box>
            ))}
          </HStack>
        </Box>
        {live && (
          <DangerOutlineButton onClick={onCancel}>
            Cancel Run
          </DangerOutlineButton>
        )}
        {(state.status === "cancelled" || state.status === "failed") && (
          <Box textAlign="right">
            <PrimaryButton onClick={onResume}>
              Resume Run
            </PrimaryButton>
            <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif">
              Continues From Last Unfinished Node
            </Text>
          </Box>
        )}
      </Flex>
    </Box>
  );
}
