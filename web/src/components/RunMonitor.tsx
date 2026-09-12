import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import EventFeed from "./EventFeed";
import type { ModelInfo, RunEvent, RunState } from "../api";

const STATUS_COLOR: Record<string, "default" | "primary" | "success" | "warning" | "error"> = {
  queued: "default",
  running: "primary",
  done: "success",
  completed: "success",
  "awaiting-gate": "warning",
  "awaiting-answers": "warning",
  failed: "error",
  cancelled: "default",
  interrupted: "error",
};

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export const roleOf = (id: string) =>
  id === "plan" ? "plan" : id === "verify" ? "verify" : id.endsWith("-fe") ? "frontend" : "backend";

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
  const totalUsage = state.nodes.reduce(
    (acc, n) => ({ input: acc.input + n.usage.input, output: acc.output + n.usage.output }),
    { input: 0, output: 0 },
  );
  const questions = state.gate?.questions ?? [];
  const effective = (nodeId: string) =>
    state.nodeModels?.[nodeId] ?? state.models[roleOf(nodeId)] ?? "auto";

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Chip label={`run ${state.id}`} size="small" />
        <Chip label={state.status} size="small" color={STATUS_COLOR[state.status] ?? "default"} />
        <Chip size="small" label={`⏱ total ${fmtDuration(wall)}`} />
        <Chip size="small" variant="outlined" label={`working ${fmtDuration(work)}`} />
        {gateMs > 0 && <Chip size="small" variant="outlined" label={`waited ${fmtDuration(gateMs)}`} />}
        {state.git?.enabled && (
          <Chip
            size="small"
            variant="outlined"
            color={state.git.merged ? "success" : "default"}
            label={`\u23a7 ${state.git.runBranch} \u2192 ${state.git.baseBranch}${state.git.merged ? " (merged)" : ` \u00b7 ${state.git.commits.length} commit(s)`}`}
          />
        )}
        <Chip
          size="small"
          variant="outlined"
          label={`tokens ▲${fmtTokens(totalUsage.input)} ▼${fmtTokens(totalUsage.output)}`}
        />
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          ORIGINAL TASK
        </Typography>
        <Typography variant="body2">{state.task}</Typography>
      </Paper>

      {state.gate?.type === "answers" && (
        <Paper variant="outlined" sx={{ p: 2, borderColor: "warning.main" }}>
          <Typography variant="subtitle2" color="warning.main">
            Clarification round {state.gate.round ?? 1} — the pipeline needs your answers
          </Typography>
          <Stack spacing={2} sx={{ mt: 1.5 }}>
            {questions.map((q, i) => (
              <Box key={q.id}>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {i + 1}. {q.question}
                  {q.type && (
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      ({q.type})
                    </Typography>
                  )}
                </Typography>
                {q.why && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                    why: {q.why}
                  </Typography>
                )}
                {q.options && q.options.length > 0 && (
                  <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 0.5, mb: 0.5 }}>
                    {q.options.map((o) => (
                      <Chip
                        key={o.label}
                        label={o.label + (o.recommended ? " ★" : "")}
                        size="small"
                        clickable
                        color={answerDrafts[q.id] === o.label ? "primary" : "default"}
                        variant={answerDrafts[q.id] === o.label ? "filled" : "outlined"}
                        onClick={() => setAnswerDrafts({ ...answerDrafts, [q.id]: o.label })}
                      />
                    ))}
                  </Stack>
                )}
                <TextField
                  fullWidth
                  size="small"
                  label={q.suggested ? `suggested: ${q.suggested}` : "your answer"}
                  value={answerDrafts[q.id] ?? q.suggested ?? ""}
                  onChange={(e) => setAnswerDrafts({ ...answerDrafts, [q.id]: e.target.value })}
                />
              </Box>
            ))}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
            <Button
              variant="contained"
              onClick={() =>
                onAnswers(
                  Object.fromEntries(
                    questions.map((q) => [q.id, answerDrafts[q.id] ?? q.suggested ?? "(no answer)"]),
                  ),
                )
              }
            >
              Submit answers
            </Button>
            <Button color="error" onClick={() => onGate("cancel")}>
              Cancel run
            </Button>
          </Stack>
        </Paper>
      )}

      {state.gate?.type === "divergence" && (
        <Paper variant="outlined" sx={{ p: 2, borderColor: "warning.main" }}>
          <Typography variant="subtitle2" color="warning.main">
            Divergence gate — {state.gate.nodeId}
          </Typography>
          <Typography variant="body2" sx={{ my: 1 }}>
            {state.gate.divergence}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => onGate("approve")}>
              Approve & continue
            </Button>
            <Button color="error" onClick={() => onGate("cancel")}>
              Cancel run
            </Button>
          </Stack>
        </Paper>
      )}

      {state.error && (
        <Typography variant="body2" color="error">
          {state.error}
        </Typography>
      )}

      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        {state.nodes.map((n) => {
          const effective = state.nodeModels?.[n.id] ?? effectiveRole(n.id, state.models);
          const pickerDisabled =
            n.status === "done" && (n.id === "plan" || n.id === "clarify" || n.id === "verify");
          return (
            <Paper
              key={n.id}
              variant="outlined"
              onClick={() => setSelectedNode(n.id)}
              sx={{
                p: 1.5,
                cursor: "pointer",
                minWidth: { xs: "100%", sm: 200 },
                borderColor: selectedNode === n.id ? "primary.main" : undefined,
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="subtitle2" noWrap>
                  {n.id}
                </Typography>
                <Chip label={n.status} size="small" color={STATUS_COLOR[n.status] ?? "default"} />
              </Stack>
              {live(n.status) && models.length > 0 ? (
                <Select
                  size="small"
                  value={effective}
                  fullWidth
                  sx={{ my: 0.5, fontSize: 12 }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e: { target: { value: string } }) => onNodeModel(n.id, e.target.value)}
                >
                  <MenuItem value="auto">
                    <em>auto</em>
                  </MenuItem>
                  {models.map((m) => (
                    <MenuItem key={m.label} value={m.label}>
                      {m.label}
                    </MenuItem>
                  ))}
                </Select>
              ) : (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {effective}
                </Typography>
              )}
              <Typography variant="caption" sx={{ display: "block" }}>
                {n.status === "running" && n.startedAt
                  ? `⏱ ${fmtDuration(now - n.startedAt)}`
                  : `took ${fmtDuration(n.durationMs)}`}
                {n.retries > 0 ? ` · ${n.retries} retr${n.retries === 1 ? "y" : "ies"}` : ""}
              </Typography>
            </Paper>
          );
        })}
      </Stack>

      {selectedNode && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="caption" color="text.secondary">
            NODE INPUT — the prompt {selectedNode} received
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 1,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              maxHeight: 260,
              overflowY: "auto",
              color: state.prompts?.[selectedNode] ? "text.primary" : "text.secondary",
            }}
          >
            {state.prompts?.[selectedNode] ??
              "(not captured — this run predates prompt capture, or the node has not run yet)"}
          </Box>
        </Paper>
      )}

      <EventFeed events={events} nodeId={selectedNode} height="42vh" />

      {state.artifacts && Object.keys(state.artifacts).length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Artifacts
          </Typography>
          {Object.entries(state.artifacts).map(([k, v]) => (
            <Box key={k}>
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" color="primary">
                {k}
              </Typography>
              <Box
                component="pre"
                sx={{ m: 0, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto" }}
              >
                {JSON.stringify(v, null, 2)}
              </Box>
            </Box>
          ))}
        </Paper>
      )}

      {(state.status === "running" || state.status.startsWith("awaiting")) && (
        <Button color="error" onClick={onCancel} sx={{ alignSelf: "flex-start" }}>
          Cancel run
        </Button>
      )}
    </Stack>
  );

  function effectiveRole(nodeId: string, m: Record<string, string>): string {
    return m[roleOf(nodeId)] ?? "auto";
  }
  function live(status: string): boolean {
    return status === "running" || status === "queued";
  }
}
