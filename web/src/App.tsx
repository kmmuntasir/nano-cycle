import { useCallback, useEffect, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { GhostButton, OutlineButton, PrimaryButton } from "./ui/buttons";
import Console from "./components/Console";
import GatePanel, { GateBanner } from "./components/GatePanel";
import StepTimeline from "./components/StepTimeline";
import RunHeader from "./components/RunHeader";
import RunsSidebar from "./components/RunsSidebar";
import Header from "./components/Header";
import NewRunModal from "./components/NewRunModal";
import ConfirmDialog from "./components/ConfirmDialog";
import StartForm from "./components/StartForm";
import Workbench from "./components/Workbench";
import { SelectEl, selectStyleMini } from "./ui/controls";
import { api, openWs } from "./api";
import type { ModelInfo, Project, RunEvent, RunState, RunSummary, SecurityMode } from "./api";
import { orderedUnits } from "./lib/pipeline";

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

type Tab = "pipeline" | "console" | "artifacts" | "qa";

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("sandbox");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  // Server caps the initial event payload (host/state.mjs EVENT_CAP); the
  // total lets the console say "latest N of M" instead of silently hiding.
  const [eventsTotal, setEventsTotal] = useState<number | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pipeline");
  const [showNew, setShowNew] = useState(false);
  const [connected, setConnected] = useState(false);
  const [task, setTask] = useState("");
  const [security, setSecurity] = useState<SecurityMode>(() => {
    const v = localStorage.getItem("nano-cycle-security");
    return v === "scan" || v === "scan+vapt" ? v : "off";
  });
  const [modelPick, setModelPick] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("nano-cycle-models") ?? "{}");
    } catch {
      return {};
    }
  });
  const [clarify, setClarify] = useState(false);
  const [requireQuestions, setRequireQuestions] = useState(false);
  const [useGit, setUseGit] = useState(true);
  const [useAudit, setUseAudit] = useState(true);
  const [approvePlan, setApprovePlan] = useState(true);
  const [remoteChecks, setRemoteChecks] = useState(false);
  const [maxFixRounds, setMaxFixRounds] = useState(2);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);

  const refreshRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem("nano-cycle-models", JSON.stringify(modelPick));
  }, [modelPick]);

  useEffect(() => {
    localStorage.setItem("nano-cycle-security", security);
  }, [security]);

  const loadRun = useCallback(async (id: string) => {
    const { state: s, events: evs, totalEvents } = await api.getRun(id);
    setRunId(id);
    setState(s);
    setEvents(evs);
    setEventsTotal(totalEvents ?? evs.length);
    setSelectedNode(orderedUnits(s)[0]?.id ?? null);
    if (s.gate?.type === "answers" || s.gate?.type === "plan-approval") setTab("qa");
    else setTab((t) => (t === "qa" ? "pipeline" : t));
    history.replaceState(null, "", `?run=${id}`);
  }, []);

  // Selection entry points (sidebar, deep link, pickers) share this wrapper —
  // a failed load surfaces as a banner instead of a silent no-op.
  const openRun = useCallback(
    async (id: string) => {
      setLoadErr(null);
      try {
        await loadRun(id);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
      }
    },
    [loadRun],
  );

  useEffect(() => {
    api.models().then(setModels).catch(() => {});
    api.roles().then(setRoles).catch(() => {});
    api.projects().then((p) => {
      setProjects(p);
      if (!p.some((x) => x.name === "sandbox")) setProject(p[0]?.name ?? "sandbox");
    }).catch(() => {});
    refreshRuns();
    const deepLink = new URLSearchParams(location.search).get("run");
    if (deepLink) openRun(deepLink);
  }, [refreshRuns, openRun]);

  useEffect(() => {
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
    // track liveness via socket events
    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    (ws as WebSocket).addEventListener?.("open", onOpen);
    (ws as WebSocket).addEventListener?.("close", onClose);
    return () => ws.close();
  }, [runId, refreshRuns]);

  // keyboard: 1-4 tabs, esc closes modal
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowNew(false);
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "1") setTab("pipeline");
      if (e.key === "2") setTab("console");
      if (e.key === "3") setTab("artifacts");
      if (e.key === "4") setTab("qa");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const start = async () => {
    setStarting(true);
    try {
      const s = await api.start(task, project, modelPick, { clarify, requireQuestions: clarify && requireQuestions, maxFixRounds, git: useGit, audit: useAudit, approvePlan, remoteChecks: remoteChecks && useGit, security });
      setShowNew(false);
      setTask("");
      await loadRun(s.id);
      setTab("pipeline");
      refreshRuns();
    } catch (e) {
      alert(String(e));
    } finally {
      setStarting(false);
    }
  };

  const addProject = async () => {
    setAddErr(null);
    try {
      const updated = await api.addProject(newName, newPath);
      setProjects(updated);
      setProject(newName.trim());
      setShowAdd(false);
      setNewName("");
      setNewPath("");
    } catch (e) {
      setAddErr(String(e));
    }
  };

  const doRemoveProject = async () => {
    setConfirmRemoveProject(false);
    try {
      const updated = await api.removeProject(project);
      setProjects(updated);
      if (!updated.some((p) => p.name === project)) setProject("sandbox");
    } catch (e) {
      alert(String(e));
    }
  };

  const gateRound = state?.gate?.round;
  const gateType = state?.gate?.type;
  useEffect(() => {
    if (gateType === "answers") setTab("qa");
  }, [gateType, gateRound]);

  const submitAnswers = (answers: Record<string, string>) => {
    setAnswerDrafts({});
    if (runId) api.answers(runId, answers);
  };

  const doCancel = () => {
    setConfirmCancel(false);
    if (runId) {
      api.cancel(runId).catch((e) => alert(String(e)));
      refreshRuns();
    }
  };

  const handleGate = (action: "approve" | "reject" | "cancel", comments?: string) => {
    if (action === "cancel") {
      setConfirmCancel(true);
      return;
    }
    if (runId) api.gate(runId, action, comments);
  };

  const handleResume = async () => {
    if (!runId) return;
    try {
      await api.resume(runId);
      await loadRun(runId);
      setTab("pipeline");
      refreshRuns();
    } catch (e) {
      alert(String(e));
    }
  };

  const live = !!state && ["running", "awaiting-gate", "awaiting-answers"].includes(state.status);
  const now = useNow(live);
  const projectPath = projects.find((p) => p.name === project)?.path ?? "";
  const wall = state ? Math.max(0, (state.finishedAt ?? now) - (Date.parse(state.createdAt) || 0)) : 0;
  const gateMs = state ? (state.gateWaitMs ?? 0) + (state.gateSince && live ? Math.max(0, now - state.gateSince) : 0) : 0;
  const work = Math.max(0, wall - gateMs);
  const liveCount = runs.filter((r) => ["running", "awaiting-gate", "awaiting-answers"].includes(r.status)).length;
  const runStart = state ? Date.parse(state.createdAt) || Date.now() : Date.now();
  const hasQA = !!state?.gate || clarify;

  const startFormEl = (
    <StartForm
      task={task}
      setTask={setTask}
      roles={roles}
      models={models}
      modelPick={modelPick}
      setModelPick={setModelPick}
      clarify={clarify}
      setClarify={setClarify}
      requireQuestions={requireQuestions}
      setRequireQuestions={setRequireQuestions}
      maxFixRounds={maxFixRounds}
      setMaxFixRounds={setMaxFixRounds}
      git={useGit}
      setGit={setUseGit}
      gitAvailable={true}
      audit={useAudit}
      setAudit={setUseAudit}
      approvePlan={approvePlan}
      setApprovePlan={setApprovePlan}
      remoteChecks={remoteChecks}
      setRemoteChecks={setRemoteChecks}
      security={security}
      setSecurity={setSecurity}
      starting={starting}
      onStart={start}
      project={project}
      projectPath={projectPath}
    />
  );

  const tabs: { id: Tab; label: string; hint: string }[] = [
    { id: "pipeline", label: "Pipeline", hint: "1" },
    { id: "console", label: `Console · ${events.length}`, hint: "2" },
    { id: "artifacts", label: `Artifacts · ${Object.keys(state?.artifacts ?? {}).length}`, hint: "3" },
    { id: "qa", label: "Q&A", hint: "4" },
  ];

  return (
    <Box minH="100dvh" bg="#0f1115">
      <Header
        projects={projects}
        project={project}
        setProject={setProject}
        onToggleAdd={() => setShowAdd((v) => !v)}
        onRemoveProject={() => setConfirmRemoveProject(true)}
        showAdd={showAdd}
        onNewRun={() => setShowNew(true)}
        connected={connected}
        liveCount={liveCount}
      />
      {showAdd && (
        <Box bg="surface" borderBottom="1px solid" borderColor="line" px={4} py={3}>
          <Flex gap={2} flexWrap="wrap" alignItems="center" maxW="720px">
            <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} style={miniInput} />
            <input placeholder="/absolute/path" value={newPath} onChange={(e) => setNewPath(e.target.value)} style={{ ...miniInput, minWidth: "280px", flex: 1 }} />
            <PrimaryButton size="xs" onClick={addProject}>Add</PrimaryButton>
            {addErr && <Text fontSize="10px" color="#f16a6a">{addErr}</Text>}
          </Flex>
        </Box>
      )}

      <Flex alignItems="stretch">
        {/* sidebar — desktop */}
        <Box
          display={{ base: "none", lg: "block" }}
          w="280px"
          flexShrink={0}
          borderRight="1px solid"
          borderColor="line"
          bg="surface"
          p={3}
          minH="calc(100dvh - 52px)"
          position="sticky"
          top="52px"
          h="calc(100dvh - 52px)"
          overflowY="auto"
        >
          <Text fontSize="10px" color="muted" letterSpacing="widest" mb={2} fontFamily="system-ui, sans-serif">
            Runs · {runs.length}
          </Text>
          <RunsSidebar runs={runs} runId={runId} onSelect={openRun} />
        </Box>

        {/* main */}
        <Box flex="1" minW={0} p={{ base: 3, md: 5 }} maxW="1100px" mx="auto" w="100%">
          {/* mobile run picker */}
          <Box display={{ base: "block", lg: "none" }} mb={3}>
            {runs.length > 0 && (
              <SelectEl
                css={{ ...selectStyleMini, width: "100%" }}
                value={runId ?? ""}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  if (v) openRun(v);
                }}
              >
                <option value="">— Select A Run —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {r.status} · {r.task.slice(0, 30)}
                  </option>
                ))}
              </SelectEl>
            )}
          </Box>

          {loadErr && (
            <Box
              border="1px solid"
              borderColor="bad"
              bg="rgba(241,106,106,0.08)"
              color="bad"
              borderRadius="md"
              px={3}
              py={2}
              mb={3}
              fontSize="12px"
              fontFamily="system-ui, sans-serif"
            >
              Failed to load run — {loadErr}
            </Box>
          )}

          {!state ? (
            <Box border="1px dashed" borderColor="line" borderRadius="lg" p={8} textAlign="center" bg="surface">
              <Text fontSize="18px" fontWeight={800} fontFamily="system-ui, sans-serif" mb={2}>
                No Run Selected
              </Text>
              <Text fontSize="13px" color="#c9cdd8" mb={4} fontFamily="system-ui, sans-serif">
                Start a run on any local project, or open recent history.
              </Text>
              <Flex gap={2} justifyContent="center" flexWrap="wrap">
                <PrimaryButton onClick={() => setShowNew(true)}>＋ New Run</PrimaryButton>
                {runs[0] && (
                  <OutlineButton onClick={() => openRun(runs[0].id)}>
                    Open {runs[0].id}
                  </OutlineButton>
                )}
              </Flex>
              <Box mt={6} display={{ base: "block", lg: "none" }}>
                <RunsSidebar runs={runs} runId={runId} onSelect={openRun} />
              </Box>
            </Box>
          ) : (
            <Stack gap={3}>
              <RunHeader state={state} wall={wall} work={work} gateMs={gateMs} live={live} onCancel={() => setConfirmCancel(true)} onResume={handleResume} />
              <GateBanner state={state} onJump={() => setTab("qa")} showJump={tab !== "qa"} />

              {/* tabs */}
              <Flex gap={1} borderBottom="1px solid" borderColor="line" pb={0}>
                {tabs
                  .filter((t) => t.id !== "qa" || hasQA || state.gate)
                  .map((t) => {
                    const active = tab === t.id;
                    const gated = t.id === "qa" && state.gate?.type === "answers";
                    return (
                      <Box
                        key={t.id}
                        as="button"
                        px={3}
                        py={2}
                        fontSize="12px"
                        fontWeight={active ? 700 : 500}
                        fontFamily="system-ui, sans-serif"
                        color={active ? "#7aa2f7" : "#8b91a0"}
                        borderBottom="2px solid"
                        borderBottomColor={active ? "#7aa2f7" : "transparent"}
                        onClick={() => setTab(t.id)}
                      >
                        {gated ? "● " : ""}{t.label}
                        <Text as="span" fontSize="9px" color="muted" ml={1}>{t.hint}</Text>
                      </Box>
                    );
                  })}
              </Flex>

              {tab === "pipeline" && (
                <Box border="1px solid" borderColor="line" borderRadius="lg" bg="surface" p={4}>
                  <StepTimeline
                    state={state}
                    models={models}
                    now={now}
                    selectedNode={selectedNode}
                    setSelectedNode={setSelectedNode}
                    onStepModel={(step, model) => runId && api.setNodeModel(runId, step, model)}
                    onViewLogs={(id) => {
                      setSelectedNode(id);
                      setTab("console");
                    }}
                  />
                </Box>
              )}
              {tab === "console" && (
                <Box border="1px solid" borderColor="line" borderRadius="lg" bg="surface" p={3}>
                  <Console
                    events={events}
                    nodes={orderedUnits(state)}
                    nodeId={selectedNode}
                    setNodeId={setSelectedNode}
                    runStart={runStart}
                    eventsTotal={eventsTotal}
                  />
                </Box>
              )}
              {tab === "artifacts" && <Workbench state={state} />}
              {tab === "qa" && (
                <GatePanel
                  state={state}
                  answerDrafts={answerDrafts}
                  setAnswerDrafts={setAnswerDrafts}
                  onAnswers={submitAnswers}
                  onGate={handleGate}
                />
              )}
              {tab !== "qa" && state.gate && (
                <Box opacity={0.9}>
                  <GatePanel
                    state={state}
                    answerDrafts={answerDrafts}
                    setAnswerDrafts={setAnswerDrafts}
                    onAnswers={submitAnswers}
                    onGate={handleGate}
                  />
                </Box>
              )}
            </Stack>
          )}
        </Box>
      </Flex>

      <NewRunModal open={showNew} onClose={() => setShowNew(false)} form={startFormEl} />
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel This Run?"
        body="Running sessions are aborted, run processes are terminated, and finished nodes keep their artifacts. You can resume the run later from the last unfinished node."
        confirmLabel="Cancel Run"
        onConfirm={doCancel}
        onClose={() => setConfirmCancel(false)}
      />
      <ConfirmDialog
        open={confirmRemoveProject}
        title={`Remove Project "${project}"?`}
        body="Registry-only removal — the folder on disk is untouched and historical runs remain viewable. Runs cannot be started on it until it is added again."
        confirmLabel="Remove Project"
        onConfirm={doRemoveProject}
        onClose={() => setConfirmRemoveProject(false)}
      />
    </Box>
  );
}

const miniInput: React.CSSProperties = {
  fontSize: "12px",
  background: "#1b1f2b",
  color: "#e4e4e7",
  border: "1px solid #2a2f3a",
  borderRadius: "6px",
  padding: "6px 8px",
};
