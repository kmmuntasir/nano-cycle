import { useState } from "react";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ModelInfo } from "../api";

export default function StartPanel({
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
  starting: boolean;
  onStart: () => void;
  project: string;
  projectPath: string;
}) {
  const [masterModel, setMasterModel] = useState("");

  const modelSelect = (role: string) => (
    <Select
      size="small"
      value={modelPick[role] ?? "auto"}
      displayEmpty
      fullWidth
      onChange={(e) => setModelPick({ ...modelPick, [role]: e.target.value })}
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
  );

  return (
    <Stack spacing={1.5}>
      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
        project: {project}
        {projectPath ? ` — ${projectPath}` : ""}
      </Typography>
      <TextField
        label="Task"
        multiline
        minRows={4}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        size="small"
      />
      <Select size="small" value={tier} onChange={(e) => setTier(e.target.value)}>
        {Object.keys(tiers).map((t) => (
          <MenuItem key={t} value={t}>
            tier {t}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              {(tiers[t] ?? []).join(" → ")}
              {t === "L" ? " (compiled from plan)" : ""}
            </Typography>
          </MenuItem>
        ))}
      </Select>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="small"
          variant={clarify ? "contained" : "outlined"}
          onClick={() => setClarify(!clarify)}
        >
          {clarify ? "✓ Clarify first" : "Clarify first"}
        </Button>
        <Typography variant="caption" color="text.secondary">
          fix rounds
        </Typography>
        <Select
          size="small"
          value={maxFixRounds}
          onChange={(e) => setMaxFixRounds(Number(e.target.value))}
          sx={{ minWidth: 64 }}
        >
          {[0, 1, 2, 3].map((n) => (
            <MenuItem key={n} value={n}>
              {n}
            </MenuItem>
          ))}
        </Select>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Models (saved in this browser)
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="caption" sx={{ width: 96 }}>
          All roles
        </Typography>
        <Select
          size="small"
          value={masterModel}
          displayEmpty
          fullWidth
          onChange={(e) => {
            setMasterModel(e.target.value);
            if (e.target.value) {
              setModelPick(
                Object.fromEntries(Object.keys(roles).map((r) => [r, e.target.value])),
              );
            }
          }}
        >
          <MenuItem value="">
            <em>choose to fill all…</em>
          </MenuItem>
          {models.map((m) => (
            <MenuItem key={m.label} value={m.label}>
              {m.label}
            </MenuItem>
          ))}
        </Select>
      </Stack>
      {Object.entries(roles).map(([role, label]) => (
        <Stack key={role} direction="row" spacing={1} alignItems="center">
          <Typography variant="caption" sx={{ width: 96 }}>
            {label}
          </Typography>
          {modelSelect(role)}
        </Stack>
      ))}
      <Button variant="contained" disabled={starting || !task.trim()} onClick={onStart}>
        {starting ? "Starting…" : "Start run"}
      </Button>
      <Typography variant="caption" color="text.secondary">
        {clarify ? "Clarify loop first (PM asks, you answer) · " : ""}
        {maxFixRounds} fix round(s) on gaps. Runs in the selected project's folder.
      </Typography>
    </Stack>
  );
}
