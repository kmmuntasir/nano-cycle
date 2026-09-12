import { useState } from "react";
import { Box, Button, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { SelectEl, selectStyle } from "../ui/controls";
import type { ModelInfo } from "../api";

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
  const roleEntries = Object.entries(roles);

  const modelSelect = (role: string) => (
    <SelectEl
      css={selectStyle}
      value={modelPick[role] ?? "auto"}
      onChange={(e) => setModelPick({ ...modelPick, [role]: e.target.value })}
    >
      <option value="auto">auto (provider default)</option>
      {models.map((m) => (
        <option key={m.label} value={m.label}>
          {m.label}
        </option>
      ))}
    </SelectEl>
  );

  const labelled = (label: string, node: React.ReactNode) => (
    <Box>
      <Text fontSize="10px" color="muted" mb={1}>
        {label}
      </Text>
      {node}
    </Box>
  );

  const selectEl = (role: string) => (
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
  );

  return (
    <Stack gap={3}>
      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          project
        </Text>
        <Text fontSize="13px">
          {project}{" "}
          <Text as="span" color="muted" fontSize="11px">
            {projectPath}
          </Text>
        </Text>
      </Box>

      {labelled(
        "task",
        <Textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          bg="surface2"
          borderColor="line"
          fontSize="13px"
        />,
      )}

      {labelled(
        "tier",
        <SelectEl
          css={selectStyle}
          value={tier}
          onChange={(e) => setTier((e.target as HTMLSelectElement).value)}
        >
          {Object.keys(tiers).map((t) => (
            <option key={t} value={t}>
              {t} — {(tiers[t] ?? []).join(" → ")}
              {t === "L" ? " (compiled from plan)" : ""}
            </option>
          ))}
        </SelectEl>,
      )}

      {labelled(
        "fix rounds on gaps",
        <SelectEl
          css={selectStyle}
          value={String(maxFixRounds)}
          onChange={(e) => setMaxFixRounds(Number((e.target as HTMLSelectElement).value))}
        >
          {[0, 1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectEl>,
      )}

      <Box>
        <Text fontSize="10px" color="muted" mb={1}>
          models per role — saved in this browser
        </Text>
        <Stack gap={2}>
          <Box>
            <Text fontSize="10px" color="muted">
              all roles (master)
            </Text>
            <SelectEl
              css={selectStyle}
              value={master}
              onChange={(e) => {
                const v = e.target.value;
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
              <Text fontSize="10px" color="muted">
                {label}
              </Text>
              {modelSelect(role)}
            </Box>
          ))}
        </Stack>
      </Box>

      <HStack gap={2} flexWrap="wrap">
        <Button
          size="sm"
          colorPalette={clarify ? "blue" : "gray"}
          variant={clarify ? "solid" : "outline"}
          onClick={() => setClarify(!clarify)}
        >
          {clarify ? "✓ clarify first" : "clarify first"}
        </Button>
        <Button
          size="sm"
          colorPalette={git ? "blue" : "gray"}
          variant={git ? "solid" : "outline"}
          disabled={!gitAvailable}
          title={
            gitAvailable
              ? "branch per run, commits per coder, ff-merge on acceptance"
              : "the scratch sandbox is not version-controlled"
          }
          onClick={() => setGit(!git)}
        >
          {git ? "✓ git" : "git off"}
        </Button>
      </HStack>

      <Button colorPalette="blue" disabled={starting || !task.trim()} onClick={onStart}>
        {starting ? "Starting…" : "Start run"}
      </Button>
      <Text fontSize="10px" color="muted">
        {clarify ? "clarify loop first (PM asks, you answer) · " : ""}
        {maxFixRounds} fix round(s) on gaps · runs in the selected project's folder
      </Text>
    </Stack>
  );
}
