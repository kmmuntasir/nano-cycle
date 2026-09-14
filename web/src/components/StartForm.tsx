import { useState } from "react";
import { Box, Flex, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { SelectEl, selectStyle } from "../ui/controls";
import { GhostButton, OutlineButton, PrimaryButton } from "../ui/buttons";
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
  starting: boolean;
  onStart: () => void;
  project: string;
  projectPath: string;
}) {
  const [master, setMaster] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const roleEntries = Object.entries(roles);
  const tierKeys = Object.keys(tiers).length > 0 ? Object.keys(tiers) : ["demo", "S", "M", "L"];

  return (
    <Stack gap={4}>
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
          rows={8}
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
                minW="120px"
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
        <Flex alignItems="center" gap={1}>
          <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">Fix Rounds:</Text>
          {[0, 1, 2, 3].map((n) => (
            <OutlineButton key={n} size="xs" active={maxFixRounds === n} onClick={() => setMaxFixRounds(n)}>
              {n}
            </OutlineButton>
          ))}
        </Flex>
      </HStack>

      <Box>
        <GhostButton onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "▾ Models Per Role" : "▸ Models Per Role (Advanced)"}
        </GhostButton>
        {advanced && (
          <Stack gap={2} mt={2}>
            <Box>
              <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">All Roles (Master)</Text>
              <SelectEl
                css={selectStyle}
                value={master}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  setMaster(v);
                  if (v) setModelPick(Object.fromEntries(roleEntries.map(([r]) => [r, v])));
                }}
              >
                <option value="">auto (provider default)</option>
                {models.map((m) => (
                  <option key={m.label} value={m.label}>
                    {m.label}
                  </option>
                ))}
              </SelectEl>
            </Box>
            {roleEntries.map(([role, label]) => (
              <Box key={role}>
                <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">{label}</Text>
                <SelectEl
                  css={selectStyle}
                  value={modelPick[role] ?? "auto"}
                  onChange={(e) => setModelPick({ ...modelPick, [role]: (e.target as HTMLSelectElement).value })}
                >
                  <option value="auto">auto (provider default)</option>
                  {models.map((m) => (
                    <option key={m.label} value={m.label}>
                      {m.label}
                    </option>
                  ))}
                </SelectEl>
              </Box>
            ))}
            <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">Saved in this browser (localStorage).</Text>
          </Stack>
        )}
      </Box>

      <PrimaryButton size="md" disabled={starting || !task.trim()} onClick={onStart}>
        {starting ? "Starting…" : `Start ${tier} Run →`}
      </PrimaryButton>
      {!task.trim() && (
        <Text fontSize="11px" color="#f0b429" fontFamily="system-ui, sans-serif">Describe the task above to enable Start.</Text>
      )}
      <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
        {clarify ? "Clarify loop first (PM asks, you answer) · " : ""}{maxFixRounds} fix round(s) · runs in {project}
      </Text>
    </Stack>
  );
}
