import { useMemo, useState } from "react";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import type { RunSummary } from "../api";

const dot = (status: string): string =>
  status === "completed"
    ? "good"
    : status === "running"
      ? "accent"
      : status === "failed" || status === "interrupted"
        ? "bad"
        : status.startsWith("awaiting")
          ? "warn"
          : "muted";

function Row({
  r,
  active,
  onSelect,
  onDelete,
}: {
  r: RunSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const deletable = !["running", "awaiting-gate", "awaiting-answers"].includes(r.status);
  return (
    <Flex
      align="center"
      gap={2}
      px={2}
      py={2}
      borderRadius="md"
      cursor="pointer"
      bg={active ? "surface2" : "transparent"}
      border="1px solid"
      borderColor={active ? "accent" : "transparent"}
      onClick={() => onSelect(r.id)}
      _hover={{ bg: "surface2" }}
    >
      <Box w="8px" h="8px" borderRadius="full" flexShrink={0} bg={dot(r.status)} />
      <Box flex="1" minW={0}>
        <Text
          fontSize="12px"
          fontWeight={active ? 700 : 500}
          fontFamily="system-ui, sans-serif"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {r.id}
        </Text>
        <Text fontSize="11px" color="ink" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" fontFamily="system-ui, sans-serif">
          {r.task.slice(0, 48) || "(No Task)"}
        </Text>
        <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
          {r.project} · {r.tier} · {r.status}
        </Text>
      </Box>
      {deletable && (
        <Box
          as="button"
          flexShrink={0}
          p={1}
          borderRadius="sm"
          color="muted"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete run ${r.id}? Its directory (state, events, sessions) is removed permanently.`)) {
              onDelete(r.id);
            }
          }}
          title="Delete this run"
          _hover={{ color: "bad", bg: "surface2" }}
        >
          <Trash2 size={12} />
        </Box>
      )}
    </Flex>
  );
}

export default function RunsSidebar({
  runs,
  runId,
  onSelect,
  onDelete,
}: {
  runs: RunSummary[];
  runId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter(
      (r) =>
        r.id.toLowerCase().includes(needle) ||
        r.task.toLowerCase().includes(needle) ||
        r.project.toLowerCase().includes(needle),
    );
  }, [runs, q]);
  const live = filtered.filter((r) => ["running", "awaiting-gate", "awaiting-answers"].includes(r.status));
  const gated = filtered.filter((r) => r.status.startsWith("awaiting"));
  const history = filtered.filter((r) => !["running", "awaiting-gate", "awaiting-answers"].includes(r.status));

  const group = (label: string, list: RunSummary[]) =>
    list.length === 0 ? null : (
      <Box key={label}>
        <Text fontSize="10px" color="muted" letterSpacing="widest" mb={1} fontFamily="system-ui, sans-serif">
          {label} · {list.length}
        </Text>
        <Stack gap={1}>
          {list.map((r) => (
            <Row key={r.id} r={r} active={runId === r.id} onSelect={onSelect} onDelete={onDelete} />
          ))}
        </Stack>
      </Box>
    );

  return (
    <Stack gap={3}>
      <Input
        value={q}
        onChange={(e) => setQ((e.target as HTMLInputElement).value)}
        placeholder="Filter Runs…"
        size="xs"
        bg="surface2"
        borderColor="line"
        color="ink"
        _placeholder={{ color: "muted" }}
        fontFamily="system-ui, sans-serif"
      />
      {filtered.length === 0 && (
        <Text fontSize="11px" color="ink" fontFamily="system-ui, sans-serif">
          {runs.length === 0 ? "No runs yet — start one with + New Run." : "No Matches"}
        </Text>
      )}
      {group("Needs Input", gated)}
      {group("Live", live.filter((r) => !r.status.startsWith("awaiting")))}
      {group("History", history)}
    </Stack>
  );
}
