import { Box, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { DangerOutlineButton, PrimaryButton, WarningButton } from "../ui/buttons";
import type { RunState } from "../api";

/** Human gates: PM question batches + plan divergences. Sticky banner + full Q&A. */
export function GateBanner({ state, onJump, showJump = true }: { state: RunState; onJump: () => void; showJump?: boolean }) {
  const gate = state.gate;
  if (!gate) return null;
  if (gate.type === "answers" && gate.questions) {
    return (
      <Box
        border="1px solid"
        borderColor="#f0b429"
        borderRadius="md"
        p={3}
        bg="#221b08"
        position="sticky"
        top="60px"
        zIndex={10}
      >
        <HStack gap={2} flexWrap="wrap" alignItems="center">
          <Text fontSize="13px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            ⏳ Clarification Round {gate.round ?? 1} Needs Your Answers
          </Text>
          <Text fontSize="11px" color="#c9cdd8" fontFamily="system-ui, sans-serif">
            {gate.questions.length} Question(s) · Pipeline Paused
          </Text>
          <Box flex="1" />
          {showJump && (
            <WarningButton onClick={onJump}>
              Answer Now →
            </WarningButton>
          )}
        </HStack>
      </Box>
    );
  }
  if (gate.type === "divergence") {
    return (
      <Box border="1px solid" borderColor="#f0b429" borderRadius="md" p={3} bg="#221b08" position="sticky" top="60px" zIndex={10}>
        <HStack gap={2} flexWrap="wrap">
          <Text fontSize="13px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            ⚠ Divergence Gate — {gate.nodeId}
          </Text>
          <Box flex="1" />
          {showJump && (
            <WarningButton onClick={onJump}>
              Review →
            </WarningButton>
          )}
        </HStack>
      </Box>
    );
  }
  return null;
}

export default function GatePanel({
  state,
  answerDrafts,
  setAnswerDrafts,
  onAnswers,
  onGate,
}: {
  state: RunState;
  answerDrafts: Record<string, string>;
  setAnswerDrafts: (d: Record<string, string>) => void;
  onAnswers: (answers: Record<string, string>) => void;
  onGate: (action: "approve" | "cancel") => void;
}) {
  const gate = state.gate;
  if (!gate) return null;

  if (gate.type === "answers" && gate.questions) {
    const answered = gate.questions.filter((q) => (answerDrafts[q.id] ?? q.suggested ?? "").trim().length > 0).length;
    return (
      <Box border="1px solid" borderColor="#f0b429" borderRadius="md" p={4} bg="surface">
        <HStack mb={3} flexWrap="wrap">
          <Text fontSize="14px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            Clarification Round {gate.round ?? 1}
          </Text>
          <Text fontSize="11px" color="#c9cdd8" fontFamily="system-ui, sans-serif">
            {answered}/{gate.questions.length} Answered · Pipeline Paused Until You Submit
          </Text>
        </HStack>
        <Stack gap={4}>
          {gate.questions.map((q, i) => (
            <Box key={q.id} border="1px solid" borderColor="line" borderRadius="md" p={3}>
              <Text fontSize="13px" fontWeight={600} fontFamily="system-ui, sans-serif">
                {i + 1}. {q.question}
                {q.type && (
                  <Text as="span" fontSize="10px" color="muted" ml={2} fontWeight={400}>
                    ({q.type === "multiple-choice" ? "Multiple Choice" : q.type === "boolean" ? "Boolean" : "Text"})
                  </Text>
                )}
              </Text>
              {q.why && (
                <Text fontSize="11px" color="#c9cdd8" mt={1} fontFamily="system-ui, sans-serif">
                  Why It Matters: {q.why}
                </Text>
              )}
              {q.options && q.options.length > 0 && (
                <HStack flexWrap="wrap" gap={2} mt={2} align="start">
                  {q.options.map((o) => {
                    const active = answerDrafts[q.id] === o.label;
                    return (
                      <Box key={o.label}>
                        <Box
                          as="button"
                          px={3}
                          py={2}
                          fontSize="12px"
                          borderRadius="md"
                          cursor="pointer"
                          border="1px solid"
                          borderColor={active ? "#7aa2f7" : "line"}
                          bg={active ? "#1b2130" : "transparent"}
                          color={active ? "#7aa2f7" : "ink"}
                          onClick={() => setAnswerDrafts({ ...answerDrafts, [q.id]: o.label })}
                          fontFamily="system-ui, sans-serif"
                          title={o.tradeoff ?? o.label}
                        >
                          {o.label}
                          {o.recommended ? " ★" : ""}
                        </Box>
                        {o.tradeoff && (
                          <Text fontSize="10px" color="muted" mt={1} maxW="220px" fontFamily="system-ui, sans-serif">
                            {o.tradeoff}
                          </Text>
                        )}
                      </Box>
                    );
                  })}
                </HStack>
              )}
              <Text fontSize="10px" color="#c9cdd8" mt={2} fontFamily="system-ui, sans-serif">
                Your answer {q.suggested ? `(suggested: ${q.suggested})` : ""} — click an option to fill, or type below:
              </Text>
              <Input
                value={answerDrafts[q.id] ?? q.suggested ?? ""}
                onChange={(e) => setAnswerDrafts({ ...answerDrafts, [q.id]: (e.target as HTMLInputElement).value })}
                placeholder="Type your answer…"
                mt={1}
                bg="surface2"
                borderColor="line"
                color="ink"
                _placeholder={{ color: "#8b91a0" }}
                fontFamily="system-ui, sans-serif"
              />
            </Box>
          ))}
        </Stack>
        <HStack mt={4}>
          <PrimaryButton
            onClick={() =>
              onAnswers(
                Object.fromEntries(
                  gate.questions!.map((q) => [q.id, answerDrafts[q.id] ?? q.suggested ?? "(no answer)"]),
                ),
              )
            }
          >
            Submit {gate.questions.length} Answer(s)
          </PrimaryButton>
          <DangerOutlineButton onClick={() => onGate("cancel")}>
            Cancel Run
          </DangerOutlineButton>
        </HStack>
      </Box>
    );
  }

  if (gate.type === "divergence") {
    return (
      <Box border="1px solid" borderColor="#f0b429" borderRadius="md" p={4} bg="surface">
        <Text fontSize="14px" fontWeight={700} color="#f0b429" mb={2} fontFamily="system-ui, sans-serif">
          Divergence Gate — {gate.nodeId}
        </Text>
        <Box as="pre" fontSize="12px" whiteSpace="pre-wrap" mb={3} fontFamily="ui-monospace, monospace">
          {gate.divergence}
        </Box>
        <HStack>
          <PrimaryButton onClick={() => onGate("approve")}>
            Approve & Continue
          </PrimaryButton>
          <DangerOutlineButton onClick={() => onGate("cancel")}>
            Cancel Run
          </DangerOutlineButton>
        </HStack>
      </Box>
    );
  }

  return null;
}
