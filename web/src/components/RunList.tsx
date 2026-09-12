import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { RunSummary } from "../api";

const STATUS_COLOR: Record<string, "default" | "primary" | "success" | "warning" | "error"> = {
  running: "primary",
  completed: "success",
  "awaiting-answers": "warning",
  "awaiting-gate": "warning",
  failed: "error",
  cancelled: "default",
  interrupted: "error",
};

export default function RunList({
  runs,
  activeId,
  onLoadRun,
}: {
  runs: RunSummary[];
  activeId: string | null;
  onLoadRun: (id: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        none yet
      </Typography>
    );
  }
  return (
    <Stack spacing={0.5}>
      {runs.map((r) => (
        <Stack key={r.id} direction="row" spacing={1} alignItems="center">
          <Button
            size="small"
            color={activeId === r.id ? "primary" : "inherit"}
            sx={{ justifyContent: "flex-start", flexGrow: 1, minWidth: 0, px: 1 }}
            onClick={() => onLoadRun(r.id)}
          >
            <Typography variant="caption" noWrap>
              {r.id} · {r.task.slice(0, 28)}
              {r.task.length > 28 ? "…" : ""}
            </Typography>
          </Button>
          <Chip label={r.status} size="small" color={STATUS_COLOR[r.status] ?? "default"} />
        </Stack>
      ))}
    </Stack>
  );
}
