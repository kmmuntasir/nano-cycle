import { Box, Button, HStack, Input, Stack, Text } from "@chakra-ui/react";
import type { RunState } from "../api";

/** Human gates: the PM's question batches and plan divergences. */
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
    return (
      <Box border="1px solid" borderColor="warn" borderRadius="md" p={3} bg="surface">
        <Text fontSize="sm" color="warn" mb={2}>
          Clarification round {gate.round ?? 1} — the pipeline needs your answers
        </Text>
        <Stack gap={3}>
          {gate.questions.map((q, i) => (
            <Box key={q.id}>
              <Text fontSize="13px">
                {i + 1}. {q.question}
                {q.type && (
                  <Text as="span" fontSize="10px" color="muted" ml={1}>
                    ({q.type})
                  </Text>
                )}
              </Text>
              {q.why && (
                <Text fontSize="11px" color="muted">
                  why: {q.why}
                </Text>
              )}
              {q.options && q.options.length > 0 && (
                <HStack flexWrap="wrap" gap={1} mt={1}>
                  {q.options.map((o) => (
                    <Box
                      as="button"
                      key={o.label}
                      px={2}
                      py={1}
                      fontSize="11px"
                      borderRadius="md"
                      cursor="pointer"
                      border="1px solid"
                      borderColor={answerDrafts[q.id] === o.label ? "accent" : "line"}
                      bg={answerDrafts[q.id] === o.label ? "surface2" : "transparent"}
                      color={answerDrafts[q.id] === o.label ? "accent" : "ink"}
                      onClick={() => setAnswerDrafts({ ...answerDrafts, [q.id]: o.label })}
                    >
                      {o.label}
                      {o.recommended ? " ★" : ""}
                    </Box>
                  ))}
                </HStack>
              )}
              <Input
                value={answerDrafts[q.id] ?? q.suggested ?? ""}
                onChange={(e) =>
                  setAnswerDrafts({ ...answerDrafts, [q.id]: (e.target as HTMLInputElement).value })
                }
                placeholder={q.suggested ? `suggested: ${q.suggested}` : "your answer"}
                css={{ width: "100%", fontSize: "12px", mt: "4px" }}
              />
            </Box>
          ))}
        </Stack>
        <HStack mt={3}>
          <Button
            size="sm"
            colorPalette="blue"
            onClick={() =>
              onAnswers(
                Object.fromEntries(
                  gate.questions!.map((q) => [q.id, answerDrafts[q.id] ?? q.suggested ?? "(no answer)"]),
                ),
              )
            }
          >
            Submit answers
          </Button>
          <Button size="sm" variant="outline" colorPalette="red" onClick={() => onGate("cancel")}>
            Cancel run
          </Button>
        </HStack>
      </Box>
    );
  }

  if (gate.type === "divergence") {
    return (
      <Box border="1px solid" borderColor="warn" borderRadius="md" p={3} bg="surface">
        <Text fontSize="sm" color="warn" mb={1}>
          Divergence gate — {gate.nodeId}
        </Text>
        <Text fontSize="13px" mb={2}>
          {gate.divergence}
        </Text>
        <HStack>
          <Button size="sm" colorPalette="blue" onClick={() => onGate("approve")}>
            Approve & continue
          </Button>
          <Button size="sm" variant="outline" colorPalette="red" onClick={() => onGate("cancel")}>
            Cancel run
          </Button>
        </HStack>
      </Box>
    );
  }

  return null;
}
