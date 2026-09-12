import { useCallback, useEffect, useState } from "react";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { useMediaQuery, useTheme } from "@mui/material";
import RunList from "./components/RunList";
import RunMonitor from "./components/RunMonitor";
import StartPanel from "./components/StartPanel";
import { api, openWs } from "./api";
import type { ModelInfo, Project, RunEvent, RunState, RunSummary } from "./api";

const TAB_MONITOR = 0;
const TAB_NEW = 1;
const TAB_HISTORY = 2;

type RunSummaryRow = RunSummary;

/** Ticks every second while a run is live so elapsed timers advance. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function AddProjectDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (projects: Project[]) => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const updated = await api.addProject(name, path);
      onAdded(updated);
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
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tiers, setTiers] = useState<Record<string, string[]>>({});
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("sandbox");
  const [addOpen, setAddOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummaryRow[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState(TAB_MONITOR);
  const [task, setTask] = useState("");
  const [tier, setTier] = useState("demo");
  const [modelPick, setModelPick] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("nano-cycle-models") ?? "{}");
    } catch {
      return {};
    }
  });
  const [clarify, setClarify] = useState(false);
  const [useGit, setUseGit] = useState(true);
  const [maxFixRounds, setMaxFixRounds] = useState(2);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);

  const refreshRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => {});
  }, []);

  // Model picks persist in this browser until the owner changes them.
  useEffect(() => {
    localStorage.setItem("nano-cycle-models", JSON.stringify(modelPick));
  }, [modelPick]);

  const loadRun = useCallback(async (id: string) => {
    const { state: s, events: evs } = await api.getRun(id);
    setRunId(id);
    setState(s);
    setEvents(evs);
    setSelectedNode(s.nodes[0]?.id ?? null);
    setTab(TAB_MONITOR);
  }, []);

  useEffect(() => {
    api.models().then(setModels).catch(() => {});
    api.tiers().then((t) => {
      setTiers(t);
      setTier((cur) => (t[cur] ? cur : Object.keys(t)[0]));
    }).catch(() => {});
    api.roles().then(setRoles).catch(() => {});
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
        if (msg.state.status !== "running" && msg.state.status !== "awaiting-gate" && msg.state.status !== "awaiting-answers") {
          refreshRuns();
        }
      } else if (msg.type === "event" && msg.runId === runId && msg.nodeId && msg.ev) {
        const ev: RunEvent = { ts: (msg.ev as { ts?: number }).ts ?? Date.now(), nodeId: msg.nodeId, ev: msg.ev };
        setEvents((prev) => [...prev.slice(-3000), ev]);
      }
    });
    return () => ws.close();
  }, [runId, refreshRuns, loadRun]);

  const start = async () => {
    setStarting(true);
    try {
      const s = await api.start(task, tier, project, modelPick, { clarify, maxFixRounds, git: useGit });
      await loadRun(s.id);
      setTab(TAB_MONITOR);
      refreshRuns();
    } catch (e) {
      alert(String(e));
    } finally {
      setStarting(false);
    }
  };

  // A new answers gate opening always pulls the owner to the monitor.
  const gateRound = state?.gate?.round;
  const gateType = state?.gate?.type;
  useEffect(() => {
    if (gateType === "answers") setTab(TAB_MONITOR);
  }, [gateType, gateRound]);

  // Seed answer drafts with each question's suggested default when a gate opens.
  useEffect(() => {
    if (state?.gate?.type === "answers") {
      const seed: Record<string, string> = {};
      for (const q of state.gate.questions ?? []) if (q.suggested) seed[q.id] = q.suggested;
      setAnswerDrafts((d) => ({ ...seed, ...d }));
    }
  }, [state?.gate?.type, state?.gate?.round]);

  const submitAnswers = (answers: Record<string, string>) => {
    setAnswerDrafts({});
    if (runId) api.answers(runId, answers);
  };

  const live = !!state && ["running", "awaiting-gate", "awaiting-answers"].includes(state.status);
  const now = useNow(live);
  const projectPath = projects.find((p) => p.name === project)?.path ?? "";

  const monitor = state ? (
    <RunMonitor
      state={state}
      events={events}
      models={models}
      now={now}
      selectedNode={selectedNode}
      setSelectedNode={setSelectedNode}
      answerDrafts={answerDrafts}
      setAnswerDrafts={setAnswerDrafts}
      onAnswers={(a) => runId && api.answers(runId, a)}
      onGate={(action) => runId && api.gate(runId, action)}
      onNodeModel={(node, model) => runId && api.setNodeModel(runId, node, model)}
      onCancel={() => runId && api.cancel(runId)}
    />
  ) : (
    <Typography variant="body2" color="text.secondary">
      Start a run or pick one from the history.
    </Typography>
  );

  const startPanel = (
    <StartPanel
      task={task}
      setTask={setTask}
      tier={tier}
      setTier={setTier}
      tiers={tiers}
      roles={roles}
      models={models}
      modelPick={modelPick}
      setModelPick={setModelPick}
      clarify={clarify}
      setClarify={setClarify}
      git={useGit}
      setGit={setUseGit}
      gitAvailable={project !== "sandbox"}
      maxFixRounds={maxFixRounds}
      setMaxFixRounds={setMaxFixRounds}
      starting={starting}
      onStart={start}
      project={project}
      projectPath={projectPath}
    />
  );

  return (
    <Box sx={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar sx={{ gap: 1.5, flexWrap: { xs: "wrap", md: "nowrap" } }}>
          <Typography variant="h6" sx={{ mr: 1 }}>
            nano-cycle
          </Typography>
          <Select
            size="small"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            sx={{ minWidth: 130, flexGrow: { xs: 1, md: 0 } }}
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
        </Toolbar>
      </AppBar>

      {isMobile && (
        <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth">
            <Tab label="Monitor" />
            <Tab label="New run" />
            <Tab label="History" />
          </Tabs>
        </Box>
      )}

      <Box sx={{ p: { xs: 1.5, md: 3 }, flexGrow: 1 }}>
        {isMobile ? (
          <Stack spacing={2}>
            {tab === TAB_MONITOR && monitor}
            {tab === TAB_NEW && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                {startPanel}
              </Paper>
            )}
            {tab === TAB_HISTORY && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <RunList runs={runs} activeId={runId} onLoadRun={(id) => loadRun(id)} />
              </Paper>
            )}
          </Stack>
        ) : (
          <Stack direction="row" spacing={3} sx={{ alignItems: "flex-start" }}>
            <Stack spacing={2} sx={{ width: 360, flexShrink: 0 }}>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  New run
                </Typography>
                {startPanel}
              </Paper>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Runs
                </Typography>
                <RunList runs={runs} activeId={runId} onLoadRun={(id) => loadRun(id)} />
              </Paper>
            </Stack>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>{monitor}</Box>
          </Stack>
        )}
      </Box>

      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(ps) => setProjects(ps)}
      />
    </Box>
  );
}
