import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { api, openWs } from "./api";
import type { ModelInfo, Project, RunEvent, RunState } from "./api";

const STATUS_COLOR: Record<string, "default" | "primary" | "success" | "warning" | "error"> = {
  queued: "default",
  running: "primary",
  done: "success",
  completed: "success",
  "awaiting-gate": "warning",
  failed: "error",
  cancelled: "default",
};

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function EventFeed({ events, nodeId }: { events: RunEvent[]; nodeId: string | null }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () => (nodeId ? events.filter((e) => e.nodeId === nodeId) : events),
    [events, nodeId],
  );
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [shown.length]);
  return (
    <Paper
      ref={feedRef}
      variant="outlined"
      sx={{ p: 1.5, height: "48vh", overflowY: "auto", bgcolor: "#0d0d0d", fontFamily: "monospace", fontSize: 13 }}
    >
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {nodeId ? "No events yet for this node." : "Select a node."}
        </Typography>
      )}
      {shown.map((e, i) => {
        const ev = e.ev;
        if (ev.t === "text") return <span key={i}>{ev.s}</span>;
        if (ev.t === "think") return <span key={i} style={{ color: "#777", fontStyle: "italic" }}>{ev.s}</span>;
        if (ev.t === "tool")
          return (
            <div key={i} style={{ color: "#90caf9", margin: "4px 0" }}>
              ▸ {ev.name} {ev.args}
            </div>
          );
        if (ev.t === "tool_end")
          return (
            <div key={i} style={{ color: ev.ok ? "#66bb6a" : "#ef5350" }}>
              ✔ {ev.name} {ev.ok ? "" : "(error)"}
            </div>
          );
        if (ev.t === "usage")
          return (
            <div key={i} style={{ color: "#888" }}>
              ⏱ tokens in {ev.usage?.input} / out {ev.usage?.output}
            </div>
          );
        if (ev.t === "notice")
          return <div key={i} style={{ color: "#ffa726", margin: "4px 0" }}>⚠ {ev.s}</div>;
        return null;
      })}
    </Paper>
  );
}

function AddProjectDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (projects: Project[], name: string) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const projects = await api.addProject(name, path);
      onAdded(projects, name.trim());
      setName("");
      setPath("");
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add project</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            helperText="Shown in the project switcher"
          />
          <TextField
            label="Local folder path (absolute)"
            size="small"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/you/projects/my-app"
            helperText="Runs execute with this directory as the node workspace"
            error={!!error}
          />
          {error && (
            <Typography variant="caption" color="error">
              {error}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim() || !path.trim()} onClick={add}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tiers, setTiers] = useState<Record<string, string[]>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("sandbox");
  const [addOpen, setAddOpen] = useState(false);
  const [runs, setRuns] = useState<{ id: string; task: string; tier: string; project: string; status: string }[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [task, setTask] = useState("Create fizzbuzz.js that prints fizzbuzz for 1..15, one per line (divisible by 3 → Fizz, by 5 → Buzz, both → FizzBuzz).");
  const [tier, setTier] = useState("demo");
  const [modelPick, setModelPick] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const refreshRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    api.models().then(setModels).catch(() => {});
    api.tiers().then((t) => {
      setTiers(t);
      setTier((cur) => (t[cur] ? cur : Object.keys(t)[0]));
    }).catch(() => {});
    api.projects().then((p) => {
      setProjects(p);
      if (!p.some((x) => x.name === "sandbox")) setProject(p[0]?.name ?? "sandbox");
    }).catch(() => {});
    refreshRuns();
    const deepLink = new URLSearchParams(location.search).get("run");
    if (deepLink) loadRun(deepLink).catch(() => {});
    const ws = openWs((msg) => {
      if (msg.type === "state" && msg.runId === runId && msg.state) {
        setState(msg.state);
        if (msg.state.status !== "running" && msg.state.status !== "awaiting-gate") refreshRuns();
      } else if (msg.type === "event" && msg.runId === runId && msg.nodeId && msg.ev) {
        const ev: RunEvent = { ts: Date.now(), nodeId: msg.nodeId, ev: msg.ev };
        setEvents((prev) => [...prev.slice(-3000), ev]);
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [runId, refreshRuns]);

  const loadRun = useCallback(async (id: string) => {
    const { state: s, events: evs } = await api.getRun(id);
    setRunId(id);
    setState(s);
    setEvents(evs);
    setSelectedNode(s.nodes[0]?.id ?? null);
  }, []);

  const start = async () => {
    setStarting(true);
    try {
      const s = await api.start(task, tier, project, modelPick);
      await loadRun(s.id);
      refreshRuns();
    } catch (e) {
      alert(String(e));
    } finally {
      setStarting(false);
    }
  };

  const nodeIds = useMemo(() => state?.nodes.map((n) => n.id) ?? [], [state]);
  const totalUsage = useMemo(
    () =>
      (state?.nodes ?? []).reduce(
        (acc, n) => ({
          input: acc.input + n.usage.input,
          output: acc.output + n.usage.output,
        }),
        { input: 0, output: 0 },
      ),
    [state],
  );
  const running = state?.status === "running" || state?.status === "awaiting-gate";
  const projectPath = projects.find((p) => p.name === project)?.path ?? "";

  return (
    <Box>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6">nano-cycle</Typography>
          <Select
            size="small"
            value={project}
            sx={{ minWidth: 160 }}
            onChange={(e) => setProject(e.target.value)}
          >
            {projects.map((p) => (
              <MenuItem key={p.name} value={p.name}>
                {p.name}
              </MenuItem>
            ))}
          </Select>
          <Button size="small" onClick={() => setAddOpen(true)}>
            Add project
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          {state && (
            <>
              <Chip label={`run ${state.id}`} size="small" />
              <Chip label={state.status} size="small" color={STATUS_COLOR[state.status] ?? "default"} />
              <Chip size="small" label={`tokens ▲${fmtTokens(totalUsage.input)} ▼${fmtTokens(totalUsage.output)}`} />
              {running && (
                <Button size="small" color="error" onClick={() => api.cancel(state.id)}>
                  Cancel
                </Button>
              )}
            </>
          )}
        </Toolbar>
      </AppBar>

      <Stack direction="row" sx={{ p: 2, gap: 2, alignItems: "flex-start" }}>
        {/* Left: start + runs */}
        <Stack spacing={2} sx={{ width: 340, flexShrink: 0 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              New run
            </Typography>
            <Stack spacing={1.5}>
              <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                project: {project} {projectPath && `— ${projectPath}`}
              </Typography>
              <TextField
                label="Task"
                multiline
                minRows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                size="small"
              />
              <Select size="small" value={tier} onChange={(e) => setTier(e.target.value)}>
                {Object.keys(tiers).map((t) => (
                  <MenuItem key={t} value={t}>
                    tier {t}
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {tiers[t]?.join(" → ")}
                    </Typography>
                  </MenuItem>
                ))}
              </Select>
              {nodeIds.length === 0 &&
                (tiers[tier] ?? []).map((n) => (
                  <Stack key={n} direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" sx={{ width: 96 }}>
                      {n} model
                    </Typography>
                    <Select
                      size="small"
                      value={modelPick[n] ?? "auto"}
                      displayEmpty
                      fullWidth
                      onChange={(e) => setModelPick((m) => ({ ...m, [n]: e.target.value }))}
                    >
                      <MenuItem value="auto">
                        <em>auto (provider default)</em>
                      </MenuItem>
                      {models.map((m) => (
                        <MenuItem key={m.label} value={m.label}>
                          {m.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </Stack>
                ))}
              <Button variant="contained" disabled={starting || !task.trim()} onClick={start}>
                {starting ? "Starting…" : "Start run"}
              </Button>
              <Typography variant="caption" color="text.secondary">
                {tier}: {(tiers[tier] ?? []).join(" → ")} (+1 fix round on gaps). Runs in the
                selected project's folder.
              </Typography>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Runs
            </Typography>
            <Stack spacing={0.5}>
              {runs.length === 0 && (
                <Typography variant="caption" color="text.secondary">
                  none yet
                </Typography>
              )}
              {runs.map((r) => (
                <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                  <Button size="small" sx={{ justifyContent: "flex-start", flexGrow: 1, minWidth: 0 }} onClick={() => loadRun(r.id)}>
                    {r.id}
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    {r.project}
                  </Typography>
                  <Chip label={r.status} size="small" color={STATUS_COLOR[r.status] ?? "default"} />
                </Stack>
              ))}
            </Stack>
          </Paper>
        </Stack>

        {/* Right: run view */}
        <Stack spacing={2} sx={{ flexGrow: 1, minWidth: 0 }}>
          {state?.gate && (
            <Paper variant="outlined" sx={{ p: 2, borderColor: "warning.main" }}>
              <Typography variant="subtitle2" color="warning.main">
                Divergence gate — {state.gate.nodeId}
              </Typography>
              <Typography variant="body2" sx={{ my: 1 }}>
                {state.gate.divergence}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" onClick={() => api.gate(state.id, "approve")}>
                  Approve & continue
                </Button>
                <Button color="error" onClick={() => api.gate(state.id, "cancel")}>
                  Cancel run
                </Button>
              </Stack>
            </Paper>
          )}

          {state && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              {state.nodes.map((n) => (
                <Paper
                  key={n.id}
                  variant="outlined"
                  onClick={() => setSelectedNode(n.id)}
                  sx={{
                    p: 1.5,
                    cursor: "pointer",
                    minWidth: 180,
                    borderColor: selectedNode === n.id ? "primary.main" : undefined,
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="subtitle2">{n.id}</Typography>
                    <Chip label={n.status} size="small" color={STATUS_COLOR[n.status] ?? "default"} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {state.models[n.id] ?? "auto"}
                  </Typography>
                  <Typography variant="caption" sx={{ display: "block" }}>
                    ▲{fmtTokens(n.usage.input)} ▼{fmtTokens(n.usage.output)}
                    {n.retries > 0 ? ` · retries ${n.retries}` : ""}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          )}

          {state?.error && (
            <Typography variant="body2" color="error">
              {state.error}
            </Typography>
          )}

          <EventFeed events={events} nodeId={selectedNode} />

          {state?.artifacts && Object.keys(state.artifacts).length > 0 && (
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
                  <Box component="pre" sx={{ m: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(v, null, 2)}
                  </Box>
                </Box>
              ))}
            </Paper>
          )}
        </Stack>
      </Stack>

      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(ps, name) => {
          setProjects(ps);
          setProject(name);
        }}
      />
    </Box>
  );
}
