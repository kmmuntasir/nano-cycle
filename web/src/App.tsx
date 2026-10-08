import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { GhostButton, OutlineButton, PrimaryButton } from "./ui/buttons";
import Console from "./components/Console";
import GatePanel, { GateBanner } from "./components/GatePanel";
import StepTimeline from "./components/StepTimeline";
import RunHeader from "./components/RunHeader";
import RunsSidebar from "./components/RunsSidebar";
import Header, { type View } from "./components/Header";
import NewRunModal from "./components/NewRunModal";
import ConfirmDialog from "./components/ConfirmDialog";
import StartForm from "./components/StartForm";
import ReviewPanel from "./components/ReviewPanel";
import TicketsView from "./components/TicketsView";
import Workbench from "./components/Workbench";
import ChatView from "./components/ChatView";
import { SelectEl, selectStyleMini } from "./ui/controls";
import { api, isAbort } from "./api";
import type { ModelInfo, Project, RunEvent, RunState, RunSummary, SecurityMode } from "./api";
import { orderedUnits } from "./lib/pipeline";
import { capAppend } from "./lib/backoff";
import { createSocket } from "./lib/socket";
import type { SocketStatus } from "./lib/socket";
import { HEADER_OFFSET } from "./ui/layout";
import { Plus } from "lucide-react";
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

// Live event buffer cap (matches the server's initial payload cap), and how
// long streamed events are coalesced before one state update.
const EVENT_CAP = 3000;
const EVENT_FLUSH_MS = 80;

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  // Last selected project persists across sessions (until removed or switched).
  const [project, setProject] = useState(() => localStorage.getItem("nano-cycle-project") ?? "sandbox");
  // The active view (Runs | Tickets | Chat) persists too — a refresh keeps
  // you exactly where you were.
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem("nano-cycle-view");
    return v === "tickets" || v === "chat" ? v : "runs";
  });
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
  const [wsStatus, setWsStatus] = useState<SocketStatus>("connecting");
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

  // The socket handler is created once; it reads the open run through a ref
  // instead of re-subscribing (and re-dialling) on every run switch.
  const runIdRef = useRef<string | null>(null);
  // Bumped by every explicit run load/clear: a slower, older response must not
  // overwrite the run the user has since moved to.
  const loadSeq = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  // Streamed events are buffered and applied in one batch per flush, so a
  // token storm is one state update (and one array copy) per ~80ms, not per token.
  const runsRef = useRef<RunSummary[]>([]);
  const lastUnknownRefresh = useRef(0);
  const evBuf = useRef<RunEvent[]>([]);
  const evTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => {});
  }, []);

  const clearEventBuffer = useCallback(() => {
    evBuf.current = [];
    if (evTimer.current) clearTimeout(evTimer.current);
    evTimer.current = null;
  }, []);

  const queueEvent = useCallback((ev: RunEvent) => {
    const buf = evBuf.current;
    buf.push(ev);
    // A hidden tab throttles timers hard; never let the buffer outgrow the cap.
    if (buf.length > EVENT_CAP * 2) buf.splice(0, buf.length - EVENT_CAP);
    if (evTimer.current) return;
    evTimer.current = setTimeout(() => {
      evTimer.current = null;
      const batch = evBuf.current;
      evBuf.current = [];
      if (batch.length) setEvents((prev) => capAppend(prev, batch, EVENT_CAP));
    }, EVENT_FLUSH_MS);
  }, []);

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const handleDeleteRun = useCallback(
    async (id: string) => {
      try {
        await api.deleteRun(id);
        if (runIdRef.current === id) {
          loadSeq.current++;
          loadAbort.current?.abort();
          clearEventBuffer();
          runIdRef.current = null;
          setRunId(null);
          setState(null);
          history.replaceState(null, "", location.pathname);
        }
        refreshRuns();
      } catch (e) {
        alert(String(e));
      }
    },
    [refreshRuns, clearEventBuffer],
  );

  useEffect(() => {
    localStorage.setItem("nano-cycle-models", JSON.stringify(modelPick));
  }, [modelPick]);

  useEffect(() => {
    localStorage.setItem("nano-cycle-project", project);
  }, [project]);

  useEffect(() => {
    localStorage.setItem("nano-cycle-view", view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem("nano-cycle-security", security);
  }, [security]);

  const loadRun = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    loadAbort.current?.abort();
    const ctl = new AbortController();
    loadAbort.current = ctl;
    let res;
    try {
      res = await api.getRun(id, ctl.signal);
    } catch (e) {
      // Superseded by a newer selection: not an error worth surfacing.
      if (seq !== loadSeq.current || isAbort(e)) return;
      throw e;
    }
    if (seq !== loadSeq.current) return;
    const { state: s, events: evs, totalEvents } = res;
    clearEventBuffer();
    // Question ids ("q1"…) repeat across runs — drafts typed for another run
    // must not leak into this one's form.
    if (runIdRef.current !== id) setAnswerDrafts({});
    runIdRef.current = id;
    setRunId(id);
    setState(s);
    setEvents(evs);
    setEventsTotal(totalEvents ?? evs.length);
    setSelectedNode(orderedUnits(s)[0]?.id ?? null);
    if (s.gate?.type === "answers" || s.gate?.type === "plan-approval") setTab("qa");
    else setTab((t) => (t === "qa" ? "pipeline" : t));
    history.replaceState(null, "", `?run=${id}`);
  }, [clearEventBuffer]);

  // After a socket drop (or the tab coming back) messages were missed: re-read
  // the open run and replace its state/events in place — selection, tab and
  // scroll are left alone. Skipped when the user switched runs meanwhile.
  const resyncRun = useCallback(() => {
    const id = runIdRef.current;
    refreshRuns();
    if (!id) return;
    const seq = loadSeq.current;
    api
      .getRun(id)
      .then(({ state: s, events: evs, totalEvents }) => {
        if (runIdRef.current !== id || loadSeq.current !== seq) return;
        clearEventBuffer();
        setState(s);
        setEvents(evs);
        setEventsTotal(totalEvents ?? evs.length);
      })
      .catch(() => {});
  }, [refreshRuns, clearEventBuffer]);

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
      // keep the stored selection when it still exists; otherwise fall back
      setProject((cur) => (p.some((x) => x.name === cur) ? cur : p[0]?.name ?? "sandbox"));
    }).catch(() => {});
    refreshRuns();
    const deepLink = new URLSearchParams(location.search).get("run");
    if (deepLink) openRun(deepLink);
  }, [refreshRuns, openRun]);

  // One socket for the app's lifetime (auto-reconnect with backoff). The server
  // broadcasts everything to everyone, so run filtering happens here via runIdRef.
  useEffect(() => {
    const emitBus = (detail: unknown) => {
      // v3: queue/tickets/chat broadcasts drive those views immediately (their
      // polls are only a fallback). Dispatched as a DOM event so they can
      // subscribe without threading the socket down.
      try {
        window.dispatchEvent(new CustomEvent("nano-ws", { detail }));
      } catch {
        /* non-vital */
      }
    };
    const sock = createSocket({
      onStatus: setWsStatus,
      onOpen: ({ reconnect }) => {
        if (!reconnect) return;
        resyncRun();
        emitBus({ type: "ws-reconnected" });
      },
      // Upgrade refused (likely 401): any authed call redirects to /login.
      onHandshakeFailure: () => {
        api.projects().catch(() => {});
      },
      onMessage: (msg) => {
        const m = msg as { type?: string; runId?: string; state?: RunState; nodeId?: string; ev?: RunEvent["ev"] };
        if (m.type === "state" && m.state) {
          const st = m.state;
          if (m.runId === runIdRef.current) setState(st);
          // Keep the sidebar/live counter honest for every run, not just the open one.
          setRuns((prev) => {
            const i = prev.findIndex((r) => r.id === m.runId);
            if (i < 0) return prev;
            if (prev[i].status === st.status) return prev;
            const next = prev.slice();
            next[i] = { ...prev[i], status: st.status };
            return next;
          });
          const finished = st.status !== "running" && st.status !== "awaiting-gate" && st.status !== "awaiting-answers";
          if (m.runId === runIdRef.current && finished) refreshRuns();
          else if (!runsRef.current.some((r) => r.id === m.runId) && Date.now() - lastUnknownRefresh.current > 1500) {
            // A run we have never listed (started from the queue / another browser).
            lastUnknownRefresh.current = Date.now();
            refreshRuns();
          }
        } else if (m.type === "event" && m.runId === runIdRef.current && m.nodeId && m.ev) {
          queueEvent({ ts: (m.ev as { ts?: number }).ts ?? Date.now(), nodeId: m.nodeId, ev: m.ev });
        }
        emitBus(msg);
      },
    });
    return () => {
      sock.close();
      if (evTimer.current) clearTimeout(evTimer.current);
      evTimer.current = null;
    };
  }, [refreshRuns, resyncRun, queueEvent]);

  // Phones freeze background tabs: when the tab comes back, re-read the open run.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 5000) resyncRun();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [resyncRun]);

  // keyboard: 1-4 tabs, esc closes modal
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowNew(false);
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      setProject((cur) => (updated.some((p) => p.name === cur) ? cur : updated[0]?.name ?? "sandbox"));
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
    if (!runId) return;
    // Keep the typed drafts until the server accepts them — a failed submit
    // (network blip, run moved on) must not eat the user's answers.
    api
      .answers(runId, answers)
      .then(() => setAnswerDrafts({}))
      .catch((e) => alert(String(e)));
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
    if (runId) api.gate(runId, action, comments).catch((e) => alert(String(e)));
  };

  const handleResume = async (fix = false) => {
    if (!runId) return;
    try {
      await api.resume(runId, { fix });
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
  // The sidebar (and mobile picker) list only the SELECTED project's history.
  const projectRuns = runs.filter((r) => r.project === project);
  const liveCount = runs.filter((r) => ["running", "awaiting-gate", "awaiting-answers"].includes(r.status)).length;
  const runStart = state ? Date.parse(state.createdAt) || Date.now() : Date.now();

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
    { id: "qa", label: "Review", hint: "4" },
  ];

  return (
    <Box minH="100dvh" bg="canvas">
      <Header
        projects={projects}
        project={project}
        setProject={setProject}
        onToggleAdd={() => setShowAdd((v) => !v)}
        onRemoveProject={() => setConfirmRemoveProject(true)}
        showAdd={showAdd}
        onNewRun={() => setShowNew(true)}
        wsStatus={wsStatus}
        liveCount={liveCount}
        view={view}
        setView={setView}
      />
      {/* Offset for the fixed header (two rows on phones, one from md up). */}
      {wsStatus === "reconnecting" && (
        <Box
          position="fixed"
          top={{ base: "103px", md: "59px" }}
          left="50%"
          transform="translateX(-50%)"
          zIndex={45}
          px={3}
          py={1}
          borderRadius="full"
          bg="surface2"
          border="1px solid"
          borderColor="warn"
          color="warn"
          fontSize="11px"
          fontFamily="system-ui, sans-serif"
          pointerEvents="none"
          role="status"
        >
          Reconnecting…
        </Box>
      )}
      <Box pt={HEADER_OFFSET}>
      {showAdd && (
        <Box bg="surface" borderBottom="1px solid" borderColor="line" px={4} py={3}>
          <Flex gap={2} flexWrap="wrap" alignItems="center" maxW="720px">
            <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} style={miniInput} />
            <input placeholder="/absolute/path" value={newPath} onChange={(e) => setNewPath(e.target.value)} style={{ ...miniInput, minWidth: "280px", flex: 1 }} />
            <PrimaryButton size="xs" onClick={addProject}>Add</PrimaryButton>
            {addErr && <Text fontSize="10px" color="bad">{addErr}</Text>}
          </Flex>
        </Box>
      )}

      {view === "chat" ? (
        <ChatView project={project} models={models} />
      ) : (
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
          minH="calc(100dvh - 53px)"
          position="sticky"
          top="53px"
          h="calc(100dvh - 53px)"
          overflowY="auto"
        >
          <Text fontSize="10px" color="muted" letterSpacing="widest" mb={2} fontFamily="system-ui, sans-serif">
            Runs · {runs.length}
          </Text>
          <RunsSidebar runs={projectRuns} runId={runId} onSelect={openRun} onDelete={handleDeleteRun} />
        </Box>

        {/* main */}
        <Box flex="1" minW={0} p={{ base: 3, md: 5 }} maxW="1100px" mx="auto" w="100%">
          {/* mobile run picker */}
          <Box display={{ base: view === "runs" ? "block" : "none", lg: "none" }} mb={3}>
            {runs.length > 0 && (
              <SelectEl
                minH="40px"
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

          {view === "tickets" ? (
            <Box maxW="1100px" mx="auto" w="100%">
              <TicketsView project={project} models={models} onOpenRun={(rid) => { setView("runs"); openRun(rid); }} />
            </Box>
          ) : !state ? (
            <Box border="1px dashed" borderColor="line" borderRadius="lg" p={{ base: 4, md: 8 }} textAlign="center" bg="surface">
              <Text fontSize="18px" fontWeight={800} fontFamily="system-ui, sans-serif" mb={2}>
                No Run Selected
              </Text>
              <Text fontSize="13px" color="ink" mb={4} fontFamily="system-ui, sans-serif">
                Start a run on any local project, or open recent history.
              </Text>
              <Flex gap={2} justifyContent="center" flexWrap="wrap">
                <PrimaryButton onClick={() => setShowNew(true)}>
                  <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
                    <Plus size={13} /> New Run
                  </Box>
                </PrimaryButton>
                {runs[0] && (
                  <OutlineButton onClick={() => openRun(runs[0].id)}>
                    Open {runs[0].id}
                  </OutlineButton>
                )}
              </Flex>
              <Box mt={6} display={{ base: "block", lg: "none" }} textAlign="left">
                <RunsSidebar runs={projectRuns} runId={runId} onSelect={openRun} onDelete={handleDeleteRun} />
              </Box>
            </Box>
          ) : view === "runs" ? (
            <Stack gap={3}>
              <RunHeader state={state} wall={wall} work={work} gateMs={gateMs} live={live} onCancel={() => setConfirmCancel(true)} onResume={() => handleResume(false)} onFixResume={() => handleResume(true)} />
              <GateBanner state={state} onJump={() => setTab("qa")} showJump={tab !== "qa"} />

              {/* tabs */}
              <Flex gap={1} borderBottom="1px solid" borderColor="line" pb={0} overflowX="auto" css={{ scrollbarWidth: "none" }}>
                {tabs
                  .map((t) => {
                    const active = tab === t.id;
                    const gated = t.id === "qa" && state.gate?.type === "answers";
                    return (
                      <Box
                        key={t.id}
                        as="button"
                        px={3}
                        py={2}
                        minH={{ base: "44px", md: "0" }}
                        flexShrink={0}
                        whiteSpace="nowrap"
                        fontSize="12px"
                        fontWeight={active ? 700 : 500}
                        fontFamily="system-ui, sans-serif"
                        color={active ? "accent" : "muted"}
                        borderBottom="2px solid"
                        borderBottomColor={active ? "accent" : "transparent"}
                        onClick={() => setTab(t.id)}
                      >
                        <Text
                          as="span"
                          display={{ base: "none", md: "inline" }}
                          fontSize="9px"
                          color={active ? "accent" : "muted"}
                          mr={1.5}
                          px={1}
                          borderRadius="3px"
                          border="1px solid"
                          borderColor={active ? "accent" : "line"}
                          fontFamily="ui-monospace, monospace"
                          title={`Press ${t.hint} to switch to ${t.label}`}
                        >
                          {t.hint}
                        </Text>
                        {gated ? (
                          <Box
                            as="span"
                            display="inline-block"
                            w="7px"
                            h="7px"
                            borderRadius="full"
                            bg="warn"
                            mr={1.5}
                            title="Needs your input"
                          />
                        ) : null}
                        {t.label}
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
                <ReviewPanel
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
          ) : null}
        </Box>
      </Flex>
      )}

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
    </Box>
  );
}

const miniInput: React.CSSProperties = {
  fontSize: "12px",
  background: "var(--chakra-colors-surface2)",
  color: "var(--chakra-colors-ink)",
  border: "1px solid var(--chakra-colors-line)",
  borderRadius: "6px",
  padding: "6px 8px",
};
