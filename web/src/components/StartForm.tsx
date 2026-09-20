import { useState } from "react";
import { Box, Flex, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { OutlineButton, PrimaryButton } from "../ui/buttons";
import ModelPicker from "../ui/ModelPicker";
import type { ModelInfo, SecurityMode } from "../api";

const SECURITY_HINT: Record<SecurityMode, string> = {
  off: "No security step",
  scan: "Scanner triage: gitleaks · deps audit · semgrep/trivy when present",
  "scan+vapt": "Scanners + running-app VAPT probes (boot & probe the real stack)",
};

export default function StartForm({
  task,
  setTask,
  roles,
  models,
  modelPick,
  setModelPick,
  clarify,
  setClarify,
  maxFixRounds,
  setMaxFixRounds,
  git,
  setGit,
  gitAvailable,
  audit,
  setAudit,
  approvePlan,
  setApprovePlan,
  remoteChecks,
  setRemoteChecks,
  security,
  setSecurity,
  starting,
  onStart,
  project,
  projectPath,
}: {
  task: string;
  setTask: (v: string) => void;
  roles: Record<string, string>;
  models: ModelInfo[];
  modelPick: Record<string, string>;
  setModelPick: (m: Record<string, string>) => void;
  clarify: boolean;
  setClarify: (v: boolean) => void;
  maxFixRounds: number;
  setMaxFixRounds: (n: number) => void;
  git: boolean;
  setGit: (v: boolean) => void;
  gitAvailable: boolean;
  audit: boolean;
  setAudit: (v: boolean) => void;
  approvePlan: boolean;
  setApprovePlan: (v: boolean) => void;
  remoteChecks: boolean;
  setRemoteChecks: (v: boolean) => void;
  security: SecurityMode;
  setSecurity: (v: SecurityMode) => void;
  starting: boolean;
  onStart: () => void;
  project: string;
  projectPath: string;
}) {
  const [master, setMaster] = useState("");
  const roleEntries = Object.entries(roles);

  return (
    <Flex direction={{ base: "column", md: "row" }} gap={5}>
      {/* left — what to build (60%) */}
      <Stack gap={4} flex="2" minW={0}>
        <Box>
          <Text fontSize="11px" color="muted" mb={1} fontFamily="system-ui, sans-serif">
            Project
          </Text>
          <Text fontSize="13px" fontFamily="system-ui, sans-serif">
            <b>{project}</b>{" "}
            <Text as="span" color="muted" fontSize="11px">
              {projectPath}
            </Text>
          </Text>
        </Box>

        <Box>
          <Text fontSize="11px" color="muted" mb={1} fontFamily="system-ui, sans-serif">
            Task — ⌘/Ctrl+Enter To Start
          </Text>
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && task.trim() && !starting) {
                e.preventDefault();
                onStart();
              }
            }}
            rows={10}
            bg="surface2"
            borderColor="line"
            color="ink"
            _placeholder={{ color: "#8b91a0" }}
            fontSize="13px"
            placeholder="Describe what to build… acceptance criteria go to the verifier verbatim."
            fontFamily="system-ui, sans-serif"
          />
        </Box>

        <Box>
          <Text fontSize="11px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
            Security (Step 4)
          </Text>
          <Flex gap={2} flexWrap="wrap">
            {(["off", "scan", "scan+vapt"] as SecurityMode[]).map((mode) => {
              const active = security === mode;
              const label = mode === "off" ? "Off" : mode === "scan" ? "Scan" : "Scan + VAPT";
              return (
                <Box
                  key={mode}
                  as="button"
                  flex="1"
                  minW="120px"
                  textAlign="left"
                  p={3}
                  borderRadius="md"
                  border="1px solid"
                  borderColor={active ? "#7aa2f7" : "line"}
                  bg={active ? "#1b2130" : "transparent"}
                  onClick={() => setSecurity(mode)}
                >
                  <Text fontSize="13px" fontWeight={800} color={active ? "#7aa2f7" : "ink"} fontFamily="system-ui, sans-serif">
                    {label}
                  </Text>
                  <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif" lineHeight="1.4">
                    {SECURITY_HINT[mode]}
                  </Text>
                </Box>
              );
            })}
          </Flex>
        </Box>

        <Box>
          <Text fontSize="11px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
            Options
          </Text>
          <HStack gap={2} flexWrap="wrap">
            <OutlineButton active={clarify} onClick={() => setClarify(!clarify)}>
              {clarify ? "✓ Clarify First" : "Clarify First"}
            </OutlineButton>
            <OutlineButton
              active={git}
              disabled={!gitAvailable}
              title={"Branch per run, milestone commits, ff-merge on acceptance. For the sandbox: run \"git init && git add -A && git commit -m init\" inside sandbox/ first — it must be its own repository."}
              onClick={() => setGit(!git)}
            >
              {git ? "✓ Git" : "Git Off"}
            </OutlineButton>
            <OutlineButton
              active={audit}
              title="Second gate after verify: conformity to the spec and repo rules, code quality, best practices."
              onClick={() => setAudit(!audit)}
            >
              {audit ? "✓ Audit" : "Audit Off"}
            </OutlineButton>
            <OutlineButton
              active={approvePlan}
              title="Pause after the plan is submitted for owner review before any code is written."
              onClick={() => setApprovePlan(!approvePlan)}
            >
              {approvePlan ? "✓ Plan Approval" : "Plan Approval Off"}
            </OutlineButton>
            <OutlineButton
              active={remoteChecks && git}
              disabled={!gitAvailable || !git}
              title={
                gitAvailable && git
                  ? "Before the final verify: push the run branch to origin and watch the hosted GitHub Actions runs it triggers — red CI gates the run. Requires gh authenticated."
                  : "Requires Git enabled."
              }
              onClick={() => setRemoteChecks(!remoteChecks)}
            >
              {remoteChecks && git ? "✓ Remote CI" : "Remote CI Off"}
            </OutlineButton>
            <Flex alignItems="center" gap={1}>
              <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">Fix Rounds:</Text>
              {[0, 1, 2, 3].map((n) => (
                <OutlineButton key={n} size="xs" active={maxFixRounds === n} onClick={() => setMaxFixRounds(n)}>
                  {n}
                </OutlineButton>
              ))}
            </Flex>
          </HStack>
        </Box>
      </Stack>

      {/* right — models + start (30%) */}
      <Box
        flex="1"
        minW={{ base: "100%", md: "230px" }}
        border="1px solid"
        borderColor="line"
        borderRadius="md"
        bg="surface2"
        p={4}
        alignSelf="flex-start"
      >
        <Text fontSize="11px" color="muted" mb={3} fontFamily="system-ui, sans-serif">
          Models Per Role
        </Text>
        <Stack gap={3}>
          <Box>
            <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">All Roles (Master)</Text>
            <ModelPicker
              value={master}
              models={models}
              onChange={(v) => {
                setMaster(v === "auto" ? "" : v);
                if (v && v !== "auto") setModelPick(Object.fromEntries(roleEntries.map(([r]) => [r, v])));
                if (v === "auto") setModelPick({});
              }}
              ariaLabel="master model"
            />
          </Box>
          {roleEntries.map(([role, label]) => (
            <Box key={role}>
              <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">{label}</Text>
              <ModelPicker
                value={modelPick[role] ?? "auto"}
                models={models}
                onChange={(v) => setModelPick({ ...modelPick, [role]: v })}
                ariaLabel={`${label} model`}
              />
            </Box>
          ))}
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">Saved in this browser (localStorage).</Text>
          <PrimaryButton size="md" disabled={starting || !task.trim()} onClick={onStart}>
            {starting ? "Starting…" : "Start Run →"}
          </PrimaryButton>
          {!task.trim() && (
            <Text fontSize="11px" color="#f0b429" fontFamily="system-ui, sans-serif">Describe the task to enable Start.</Text>
          )}
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
            {clarify ? "Clarify loop first (PM asks, you answer) · " : ""}{maxFixRounds} fix round(s) · {security === "off" ? "no security step" : `security: ${security}`} · runs in {project}
          </Text>
        </Stack>
      </Box>
    </Flex>
  );
}
