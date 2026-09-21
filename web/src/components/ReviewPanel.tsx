import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { Check, ClipboardList, MessageCircle, Star } from "lucide-react";
import GatePanel from "./GatePanel";
import type { PlanApproval, RunState } from "../api";

/** The plan rendered the way it was presented at the approval gate — not JSON. */
function PlanReviewCard({ plan }: { plan: PlanApproval | undefined }) {
  if (!plan) return null;
  const files: { path: string; purpose?: string }[] = (plan.files ?? []).map((f) =>
      typeof f === "string" ? { path: f } : { path: f.path, purpose: f.purpose },
    )
    .concat([
      ...(plan.backend ?? []).map((p) => ({ path: p, purpose: "backend" })),
      ...(plan.frontend ?? []).map((p) => ({ path: p, purpose: "frontend" })),
    ]);
  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" p={4} bg="surface">
      <HStack mb={2}>
        <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="14px" fontWeight={700} color="accent" fontFamily="system-ui, sans-serif">
          <ClipboardList size={15} /> Plan
        </Box>
        <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
          exactly as it was presented for approval
        </Text>
      </HStack>
      <Box border="1px solid" borderColor="line" borderRadius="md" p={3} mb={3}>
        <Text fontSize="12px" fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {plan.task_summary}
        </Text>
        {plan.approach && (
          <Text fontSize="11px" color="ink" mt={2} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
            approach: {plan.approach}
          </Text>
        )}
      </Box>
      {files.length > 0 && (
        <Stack gap={2} mb={3}>
          <Text fontSize="11px" fontFamily="ui-monospace, monospace" whiteSpace="pre-wrap">
            files:
            {files.map((f) => (
              <Text key={f.path + f.purpose} as="span" display="block" ml={3} color="ink">
                {f.path}
                {f.purpose ? <Text as="span" color="muted"> — {f.purpose}</Text> : null}
              </Text>
            ))}
          </Text>
        </Stack>
      )}
      {(plan.acceptance_criteria?.length ?? 0) > 0 && (
        <>
          <Text fontSize="12px" fontWeight={600} mb={1} fontFamily="system-ui, sans-serif">
            Acceptance criteria ({plan.acceptance_criteria.length})
          </Text>
          <Stack gap={1} mb={1}>
            {plan.acceptance_criteria.map((c, i) => (
              <Text key={i} fontSize="11px" color="ink" fontFamily="system-ui, sans-serif">
                • {c}
              </Text>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}

/** The clarification transcript: what was asked, which options were presented,
 *  and the answer that was given — for every round, at any point of the run. */
function ClarificationTranscript({ state }: { state: RunState }) {
  const qa = state.qa ?? [];
  const pending = state.pendingQuestions;
  if (qa.length === 0 && !pending) return null;
  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" p={4} bg="surface">
      <HStack mb={3}>
        <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="14px" fontWeight={700} color="accent" fontFamily="system-ui, sans-serif">
          <MessageCircle size={15} /> Clarification
        </Box>
        <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
          {qa.length} answered round(s)
          {pending ? ` · ${pending.questions.length} answer pending` : ""}
        </Text>
      </HStack>
      <Stack gap={3}>
        {qa.map((r) => (
          <Box key={r.round}>
            <Text fontSize="11px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
              Round {r.round}
            </Text>
            <Stack gap={2}>
              {r.questions.map((q, i) => (
                <Box key={q.id} border="1px solid" borderColor="line" borderRadius="md" p={3}>
                  <Text fontSize="12px" fontWeight={600} fontFamily="system-ui, sans-serif">
                    {i + 1}. {q.question}
                  </Text>
                  {q.options && q.options.length > 0 && (
                    <HStack flexWrap="wrap" gap={1.5} mt={2}>
                      {q.options.map((o) => {
                        const chosen = r.answers[q.id] === o.label;
                        return (
                          <Box
                            key={o.label}
                            px={2}
                            py={1}
                            fontSize="11px"
                            borderRadius="sm"
                            border="1px solid"
                            borderColor={chosen ? "accent" : "line"}
                            bg={chosen ? "surface2" : "transparent"}
                            color={chosen ? "accent" : "muted"}
                            fontFamily="system-ui, sans-serif"
                          >
                            <Box as="span" display="inline-flex" alignItems="center" gap={1}>
                              {chosen ? <Check size={11} /> : null}
                              {o.label}
                              {o.recommended ? <Star size={10} /> : null}
                            </Box>
                          </Box>
                        );
                      })}
                    </HStack>
                  )}
                  <Text fontSize="11px" color="good" mt={2} fontFamily="system-ui, sans-serif">
                    your answer: {r.answers[q.id] ?? "(no answer)"}
                  </Text>
                </Box>
              ))}
            </Stack>
          </Box>
        ))}
        {pending && (
          <Box border="1px dashed" borderColor="#f0b429" borderRadius="md" p={3}>
            <Text fontSize="11px" color="warn" fontFamily="system-ui, sans-serif" mb={2}>
              Round {pending.round} — interrupted before these were answered:
            </Text>
            <Stack gap={1}>
              {pending.questions.map((q) => (
                <Text key={q.id} fontSize="11px" color="ink" fontFamily="system-ui, sans-serif">
                  • {q.question}
                </Text>
              ))}
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

/** The Review tab: interactive gate (when one is open) + the plan as presented
 *  + the full clarification transcript — available at any point of the run. */
export default function ReviewPanel({
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
  onGate: (action: "approve" | "reject" | "cancel", comments?: string) => void;
}) {
  const plan = state.artifacts?.plan as PlanApproval | undefined;
  const qa = state.qa ?? [];
  const nothing = !state.gate && !plan && qa.length === 0 && !state.pendingQuestions;
  return (
    <Stack gap={3}>
      <GatePanel
        state={state}
        answerDrafts={answerDrafts}
        setAnswerDrafts={setAnswerDrafts}
        onAnswers={onAnswers}
        onGate={onGate}
      />
      {!state.gate && nothing && (
        <Box border="1px dashed" borderColor="line" borderRadius="md" p={6} textAlign="center">
          <Text fontSize="12px" color="muted" fontFamily="system-ui, sans-serif">
            Nothing to review yet — clarification Q&A and the plan appear here as the run produces them.
          </Text>
        </Box>
      )}
      <PlanReviewCard plan={plan} />
      <ClarificationTranscript state={state} />
    </Stack>
  );
}
