import { useState } from "react";
import { Box, Flex, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { OutlineButton, PrimaryButton } from "../ui/buttons";
import ModelPicker from "../ui/ModelPicker";
import type { ModelInfo } from "../api";

const TIER_HINT: Record<string, string> = {
  demo: "Plan → Implement → Verify · Scratch Tasks",
  S: "Implement → Verify · Skip Planning",
  M: "Plan → BE ∥ FE → Verify · One Slice",
  L: "Plan → Capability Graph → Verify · Complex",
};

export default function StartForm({
  task,
  setTask,
  tier,
  setTier,
  tiers,
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
  starting,
  onStart,
  project,
  projectPath,
}: {
  task: string;
  setTask: (v: string) => void;
  tier: string;
  setTier: (v: string) => void;
  tiers: Record<string, string[]>;
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
  starting: boolean;
  onStart: () => void;
  project: string;
  projectPath: string;
}) {
  const [master, setMaster] = useState("");
  const roleEntries = Object.entries(roles);
  const tierKeys = Object.keys(tiers).length > 0 ? Object.keys(tiers) : ["demo", "S", "M", "L"];

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
            Tier
          </Text>
          <Flex gap={2} flexWrap="wrap">
            {tierKeys.map((t) => {
              const active = tier === t;
              return (
                <Box
                  key={t}
                  as="button"
                  flex="1"
                  minW="110px"
                  textAlign="left"
                  p={3}
                  borderRadius="md"
                  border="1px solid"
                  borderColor={active ? "#7aa2f7" : "line"}
                  bg={active ? "#1b2130" : "transparent"}
                  onClick={() => setTier(t)}
                >
                  <Text fontSize="13px" fontWeight={800} color={active ? "#7aa2f7" : "ink"} fontFamily="system-ui, sans-serif">
                    {t}
                  </Text>
                  <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif" lineHeight="1.4">
                    {TIER_HINT[t] ?? (tiers[t] ?? []).join(" → ")}
                  </Text>
                </Box>
              );
            })}
          </Flex>
          <Text fontSize="10px" color="muted" mt={1} fontFamily="system-ui, sans-serif">
            {(tiers[tier] ?? []).join(" → ")}
            {tier === "L" ? " (compiled from plan)" : ""}
          </Text>
        </Box>

        <Box>
          <Text fontSize="11px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
            Plan
          </Text>
          <HStack gap={2} flexWrap="wrap">
            <OutlineButton active={clarify} onClick={() => setClarify(!clarify)}>
              {clarify ? "✓ Clarify First" : "Clarify First"}
            </OutlineButton>
            <OutlineButton
              active={git}
              disabled={!gitAvailable}
              title={gitAvailable ? "Branch per run, commits per coder, ff-merge on acceptance." : "The scratch sandbox is not version-controlled."}
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
            {starting ? "Starting…" : `Start ${tier} Run →`}
          </PrimaryButton>
          {!task.trim() && (
            <Text fontSize="11px" color="#f0b429" fontFamily="system-ui, sans-serif">Describe the task to enable Start.</Text>
          )}
          <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
            {clarify ? "Clarify loop first (PM asks, you answer) · " : ""}{maxFixRounds} fix round(s) · runs in {project}
          </Text>
        </Stack>
      </Box>
    </Flex>
  );
}
