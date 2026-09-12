import { useCallback, useEffect, useState } from "react";
import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import Console from "./components/Console";
import GatePanel from "./components/GatePanel";
import PipelineStrip from "./components/PipelineStrip";
import StartForm from "./components/StartForm";
import StatsStrip from "./components/StatsStrip";
import Workbench from "./components/Workbench";
import { SelectEl, selectStyle, selectStyleMini } from "./ui/controls";
import { api, openWs } from "./api";
import type { ModelInfo, Project, RunEvent, RunState, RunSummary } from "./api";
import { fmtDuration } from "./lib/format";

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

const statusDot = (status: string): string =>
  status === "completed"
    ? "good"
    : status === "running"
      ? "accent"
      : status === "failed" || status === "interrupted"
        ? "bad"
        : status.startsWith("awaiting")
          ? "warn"
          : "muted";

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tiers, setTiers] = useState<Record<string, string[]>>({});
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
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"monitor" | "new" | "history">("monitor");
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
    setMobileTab("monitor");
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
      setMobileTab("monitor");
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

  // A new answers gate opening always pulls the owner to the monitor.
  const gateRound = state?.gate?.round;
  const gateType = state?.gate?.type;
  useEffect(() => {
    if (gateType === "answers") setMobileTab("monitor");
  }, [gateType, gateRound]);

  const submitAnswers = (answers: Record<string, string>) => {
    setAnswerDrafts({});
    if (runId) api.answers(runId, answers);
  };

  const live = !!state && ["running", "awaiting-gate", "awaiting-answers"].includes(state.status);
  const now = useNow(live);
  const projectPath = projects.find((p) => p.name === project)?.path ?? "";
  const wall = state ? Math.max(0, (state.finishedAt ?? now) - (Date.parse(state.createdAt) || 0)) : 0;
  const gateMs = state
    ? (state.gateWaitMs ?? 0) + (state.gateSince && live ? Math.max(0, now - state.gateSince) : 0)
    : 0;
  const work = Math.max(0, wall - gateMs);

  const addProjectForm = (
    <Stack gap={2}>
      <input placeholder="name" value={newName} onChange={(e) => setNewName(e.target.value)} style={miniInput} />
      <input
        placeholder="/absolute/path"
        value={newPath}
        onChange={(e) => setNewPath(e.target.value)}
        style={miniInput}
      />
      <Button size="xs" onClick={addProject}>
        Add
      </Button>
      {addErr && (
        <Text fontSize="10px" color="bad">
          {addErr}
        </Text>
      )}
    </Stack>
  );

  const startForm = (
    <StartForm
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
      maxFixRounds={maxFixRounds}
      setMaxFixRounds={setMaxFixRounds}
      git={useGit}
      setGit={setUseGit}
      gitAvailable={project !== "sandbox"}
      starting={starting}
      onStart={start}
      project={project}
      projectPath={projectPath}
    />
  );

  const runList = (
    <Stack gap={1}>
      {runs.length === 0 && (
        <Text fontSize="11px" color="muted">
          none yet
        </Text>
      )}
      {runs.map((r) => (
        <Flex
          key={r.id}
          align="center"
          gap={2}
          px={2}
          py={1}
          borderRadius="md"
          cursor="pointer"
          bg={runId === r.id ? "surface2" : "transparent"}
          onClick={() => loadRun(r.id)}
          _hover={{ bg: "surface2" }}
        >
          <Box w="7px" h="7px" borderRadius="full" flexShrink={0} bg={statusDot(r.status)} />
          <Text fontSize="11px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1" minW={0}>
            {r.id} · {r.task.slice(0, 24)}
            {r.task.length > 24 ? "…" : ""}
          </Text>
          <Text fontSize="10px" color="muted">
            {r.project}
          </Text>
        </Flex>
      ))}
    </Stack>
  );

  const monitor = state ? (
    <Stack gap={3}>
      <StatsStrip state={state} wall={wall} work={work} gateMs={gateMs} />
      <Box border="1px solid" borderColor="line" borderRadius="md" p={3} bg="surface">
        <Text fontSize="10px" color="muted" mb={1}>
          ORIGINAL TASK
        </Text>
        <Text fontSize="13px">{state.task}</Text>
      </Box>
      <GatePanel
        state={state}
        answerDrafts={answerDrafts}
        setAnswerDrafts={setAnswerDrafts}
        onAnswers={submitAnswers}
        onGate={(action) => runId && api.gate(runId, action)}
      />
      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          pipeline
        </Text>
        <PipelineStrip
          state={state}
          models={models}
          now={now}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          onNodeModel={(node, model) => runId && api.setNodeModel(runId, node, model)}
        />
      </Box>
      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          console — {selectedNode ?? "select a node"}
        </Text>
        <Console events={events} nodeId={selectedNode} />
      </Box>
      <Workbench state={state} />
      {live && (
        <Button
          size="xs"
          variant="outline"
          colorPalette="red"
          onClick={() => runId && api.cancel(runId)}
          alignSelf="flex-start"
        >
          Cancel run
        </Button>
      )}
    </Stack>
  ) : (
    <Stack gap={3} alignItems="flex-start">
      <Text color="muted">No run selected — start one, or open the last run below.</Text>
      {runs[0] && (
        <Button size="sm" onClick={() => loadRun(runs[0].id)}>
          Open {runs[0].id}
        </Button>
      )}
    </Stack>
  );

  return (
    <Flex minH="100dvh">
      {/* left rail — desktop */}
      <Flex
        display={{ base: "none", lg: "flex" }}
        direction="column"
        w="300px"
        flexShrink={0}
        borderRight="1px solid"
        borderColor="line"
        bg="surface"
        p={4}
        gap={4}
      >
        <Text fontSize="lg" fontWeight="bold">
          nano-cycle
        </Text>
        <Box>
          <Text fontSize="10px" color="muted" mb={1}>
            project
          </Text>
          <SelectEl
            css={selectStyleMini}
            value={project}
            onChange={(e) => setProject((e.target as HTMLSelectElement).value)}
          >
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </SelectEl>
          {!showAdd ? (
            <Button size="xs" variant="ghost" mt={1} onClick={() => setShowAdd(true)}>
              + add project
            </Button>
          ) : (
            addProjectForm
          )}
        </Box>
        {startForm}
        <Box>
          <Text fontSize="10px" color="muted" mb={1}>
            runs
          </Text>
          {runList}
        </Box>
      </Flex>

      {/* main */}
      <Box flex="1" minW={0}>
        {/* mobile top bar */}
        <Flex
          display={{ base: "flex", lg: "none" }}
          p={3}
          gap={2}
          borderBottom="1px solid"
          borderColor="line"
          bg="surface"
          alignItems="center"
          flexWrap="wrap"
        >
          <Text fontWeight="bold" mr={1}>
            nano-cycle
          </Text>
          <SelectEl
            css={{ ...selectStyleMini, width: "auto", flexGrow: 1 }}
            value={project}
            onChange={(e) => setProject((e.target as HTMLSelectElement).value)}
          >
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </SelectEl>
          <Button size="xs" variant="outline" onClick={() => setShowAdd((v) => !v)}>
            + project
          </Button>
          {showAdd && addProjectForm}
          {runs.length > 0 && (
            <SelectEl
              css={{ ...selectStyleMini, width: "100%" }}
              value={runId ?? ""}
              onChange={(e) => loadRun((e.target as HTMLSelectElement).value)}
            >
              <option value="">— runs —</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.status}
                </option>
              ))}
            </SelectEl>
          )}
        </Flex>

        <Box p={{ base: 3, md: 5 }}>
          {/* mobile: new-run form toggle */}
          <Button
            size="xs"
            colorPalette="blue"
            mb={3}
            display={{ base: "inline-flex", lg: "none" }}
            onClick={() => setMobileTab((v) => (v === "new" ? "monitor" : "new"))}
          >
            {mobileTab === "new" ? "close form" : "＋ new run"}
          </Button>
          {mobileTab === "new" && (
            <Box mb={4} border="1px solid" borderColor="line" borderRadius="md" p={3} bg="surface">
              {startForm}
            </Box>
          )}

          <Flex align="center" gap={2} mb={3}>
            <Text fontSize="lg" fontWeight="bold">
              runs
            </Text>
          </Flex>
          {runList}
          {monitor}
        </Box>
      </Box>
    </Flex>
  );
}

const miniInput: React.CSSProperties = {
  width: "100%",
  fontSize: "12px",
  background: "#1b1f2b",
  color: "#e4e4e7",
  border: "1px solid #2a2f3a",
  borderRadius: "6px",
  padding: "6px 8px",
};
