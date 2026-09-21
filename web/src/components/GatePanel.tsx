import { useState } from "react";
import { Box, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { ClipboardList, Hourglass, ShieldAlert, Star, TriangleAlert } from "lucide-react";
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
          <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="13px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            <Hourglass size={14} /> Clarification Round {gate.round ?? 1} Needs Your Answers
          </Box>
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
          <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="13px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            <TriangleAlert size={14} /> Divergence Gate — {gate.nodeId}
          </Box>
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
  if (gate.type === "plan-approval" && gate.plan) {
    return (
      <Box border="1px solid" borderColor="#f0b429" borderRadius="md" p={3} bg="#221b08" position="sticky" top="60px" zIndex={10}>
        <HStack gap={2} flexWrap="wrap">
          <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="13px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
            <ClipboardList size={14} /> Plan Ready — Approval Needed
          </Box>
          <Text fontSize="11px" color="#c9cdd8" fontFamily="system-ui, sans-serif">
            No Code Runs Until You Approve
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
  if (gate.type === "security-override") {
    return (
      <Box border="1px solid" borderColor="#f16a6a" borderRadius="md" p={3} bg="#230f0f" position="sticky" top="60px" zIndex={10}>
        <HStack gap={2} flexWrap="wrap">
          <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="13px" fontWeight={700} color="#f16a6a" fontFamily="system-ui, sans-serif">
            <ShieldAlert size={14} /> Security Override Needed — {gate.findings?.length ?? 0} unfixable critical/high finding(s)
          </Box>
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
  onGate: (action: "approve" | "reject" | "cancel", comments?: string) => void;
}) {
  const gate = state.gate;
  const [rejectComments, setRejectComments] = useState("");
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
                          borderColor={active ? "accent" : "line"}
                          bg={active ? "surface2" : "transparent"}
                          color={active ? "accent" : "ink"}
                          onClick={() => setAnswerDrafts({ ...answerDrafts, [q.id]: o.label })}
                          fontFamily="system-ui, sans-serif"
                          title={o.tradeoff ?? o.label}
                        >
                          <Box as="span" display="inline-flex" alignItems="center" gap={1}>
                            {o.label}
                            {o.recommended ? <Star size={11} /> : null}
                          </Box>
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
              <Text fontSize="10px" color="ink" mt={2} fontFamily="system-ui, sans-serif">
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
                _placeholder={{ color: "muted" }}
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

  if (gate.type === "plan-approval" && gate.plan) {
    const plan = gate.plan;
    return (
      <Box border="1px solid" borderColor="#f0b429" borderRadius="md" p={4} bg="surface">
        <Text fontSize="14px" fontWeight={700} color="#f0b429" mb={2} fontFamily="system-ui, sans-serif">
          Plan Approval — review before any code is written
        </Text>
        <Box border="1px solid" borderColor="line" borderRadius="md" p={3} mb={3}>
          <Text fontSize="12px" fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
            {plan.task_summary}
          </Text>
          {plan.approach && (
            <Text fontSize="11px" color="#c9cdd8" mt={2} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
              approach: {plan.approach}
            </Text>
          )}
        </Box>
        {plan.capabilities && plan.capabilities.length > 0 ? (
          <Box mb={3} overflowX="auto">
            <Box as="table" fontSize="11px" fontFamily="ui-monospace, monospace" minWidth="560px" borderCollapse="collapse">
              <Box as="thead" borderBottom="1px solid" borderColor="line">
                <Box as="tr">
                  {["capability", "backend files", "frontend files", "depends on", "class"].map((h) => (
                    <Box as="th" key={h} textAlign="left" px={2} py={1} color="muted" fontWeight={600} whiteSpace="nowrap">
                      {h}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box as="tbody">
                {plan.capabilities.map((c) => (
                  <Box as="tr" key={c.id} borderBottom="1px solid" borderColor="line">
                    <Box as="td" px={2} py={1} color="#7aa2f7" whiteSpace="nowrap">
                      {c.id}
                      <Text as="span" color="muted"> · {c.title}</Text>
                    </Box>
                    <Box as="td" px={2} py={1} color="ink" maxW="260px" whiteSpace="pre-wrap">
                      {c.backend.length ? c.backend.join("\n") : "—"}
                    </Box>
                    <Box as="td" px={2} py={1} color="ink" maxW="260px" whiteSpace="pre-wrap">
                      {c.frontend.length ? c.frontend.join("\n") : "—"}
                    </Box>
                    <Box as="td" px={2} py={1} color="muted" whiteSpace="nowrap">
                      {c.dependsOn.length ? c.dependsOn.join(", ") : "—"}
                    </Box>
                    <Box as="td" px={2} py={1} color="muted" whiteSpace="nowrap">
                      {c.single_side_class ?? ""}
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        ) : (
          <Stack gap={2} mb={3}>
            {(plan.files?.length ?? 0) > 0 && (
              <Text fontSize="11px" fontFamily="ui-monospace, monospace" whiteSpace="pre-wrap">
                files: {plan.files!.join("\n       ")}
              </Text>
            )}
            {(plan.backend?.length ?? 0) > 0 && (
              <Text fontSize="11px" fontFamily="ui-monospace, monospace" whiteSpace="pre-wrap">
                backend: {plan.backend!.join("\n         ")}
              </Text>
            )}
            {(plan.frontend?.length ?? 0) > 0 && (
              <Text fontSize="11px" fontFamily="ui-monospace, monospace" whiteSpace="pre-wrap">
                frontend: {plan.frontend!.join("\n           ")}
              </Text>
            )}
          </Stack>
        )}
        <Text fontSize="12px" fontWeight={600} mb={1} fontFamily="system-ui, sans-serif">
          Acceptance criteria ({plan.acceptance_criteria.length})
        </Text>
        <Stack gap={1} mb={4}>
          {plan.acceptance_criteria.map((c, i) => (
            <Text key={i} fontSize="11px" color="#c9cdd8" fontFamily="system-ui, sans-serif">
              • {c}
            </Text>
          ))}
        </Stack>
        <HStack mt={2} alignItems="flex-start">
          <PrimaryButton onClick={() => onGate("approve")}>
            Approve & Continue
          </PrimaryButton>
          <DangerOutlineButton onClick={() => onGate("cancel")}>
            Cancel Run
          </DangerOutlineButton>
        </HStack>
        <Box mt={3} border="1px dashed" borderColor="line" borderRadius="md" p={2}>
          <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">
            Reject with comments — the builder revises the plan in its own session and resubmits:
          </Text>
          <HStack alignItems="flex-start">
            <Textarea
              value={rejectComments}
              onChange={(e) => setRejectComments(e.target.value)}
              placeholder="What must change before you approve…"
              rows={2}
              bg="surface2"
              borderColor="line"
              color="ink"
              fontSize="12px"
              fontFamily="system-ui, sans-serif"
              _placeholder={{ color: "#8b91a0" }}
              w="100%"
            />
            <WarningButton
              disabled={!rejectComments.trim()}
              onClick={() => {
                onGate("reject", rejectComments.trim());
                setRejectComments("");
              }}
            >
              Reject ↓
            </WarningButton>
          </HStack>
        </Box>
      </Box>
    );
  }

  if (gate.type === "security-override" && gate.findings) {
    return (
      <Box border="1px solid" borderColor="#f16a6a" borderRadius="md" p={4} bg="surface">
        <Text fontSize="14px" fontWeight={700} color="#f16a6a" mb={1} fontFamily="system-ui, sans-serif">
          Security Override — {gate.findings.length} critical/high finding(s) not fixable in this run's scope
        </Text>
        <Text fontSize="11px" color="#c9cdd8" mb={3} fontFamily="system-ui, sans-serif">
          Accept the risk (recorded on the run, verification continues) or cancel the run.
        </Text>
        <Stack gap={2} mb={4}>
          {gate.findings.map((f, i) => (
            <Box key={i} border="1px solid" borderColor="line" borderRadius="md" p={2}>
              <HStack gap={2} flexWrap="wrap">
                <Text fontSize="11px" fontWeight={700} color="#f16a6a" fontFamily="ui-monospace, monospace">
                  [{f.severity}]
                </Text>
                <Text fontSize="12px" fontWeight={600} fontFamily="system-ui, sans-serif">
                  {f.title}
                </Text>
              </HStack>
              <Text fontSize="11px" color="#c9cdd8" mt={1} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
                {f.evidence}
              </Text>
              {f.fix && (
                <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif">
                  remediation: {f.fix}
                </Text>
              )}
            </Box>
          ))}
        </Stack>
        <HStack>
          <WarningButton onClick={() => onGate("approve")}>
            Accept Risk & Continue
          </WarningButton>
          <DangerOutlineButton onClick={() => onGate("cancel")}>
            Cancel Run
          </DangerOutlineButton>
        </HStack>
      </Box>
    );
  }

  return null;
}
