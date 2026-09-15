import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Text } from "@chakra-ui/react";
import type { ModelInfo } from "../api";

const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Split "provider/model:level" into base + level (null when no valid suffix). */
function splitSpec(value: string): { base: string; level: string | null } {
  if (!value || value === "auto") return { base: value || "auto", level: null };
  const idx = value.lastIndexOf(":");
  if (idx > value.lastIndexOf("/") && idx > 0) {
    const maybe = value.slice(idx + 1).toLowerCase();
    if (KNOWN_LEVELS.includes(maybe)) return { base: value.slice(0, idx), level: maybe };
  }
  return { base: value, level: null };
}

/** Searchable model dropdown — native <select> can't filter a long model list.
 *  When the selected model reports supported thinking levels, a second compact
 *  dropdown beside it sets the ":level" suffix (empty = node/session default). */
export default function ModelPicker({
  value,
  models,
  onChange,
  compact,
  ariaLabel,
}: {
  value: string;
  models: ModelInfo[];
  onChange: (v: string) => void;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) => m.label.toLowerCase().includes(needle));
  }, [models, q]);

  const { base, level } = splitSpec(value);
  const selected = useMemo(() => models.find((m) => m.label === base) ?? null, [models, base]);
  const levels = selected?.thinkingLevels?.length ? selected.thinkingLevels : null;

  const display = !value || value === "auto" ? "Auto (Provider Default)" : base;

  const pick = (v: string) => {
    // Keep the current thinking level only if the newly picked model supports it.
    const next = models.find((m) => m.label === v) ?? null;
    const kept = level && next?.thinkingLevels?.includes(level) ? `${v}:${level}` : v;
    onChange(kept);
    setOpen(false);
    setQ("");
  };

  const levelStyle: React.CSSProperties = {
    fontSize: compact ? "10px" : "11px",
    background: "#1b1f2b",
    color: "#e4e4e7",
    border: "1px solid #3a4152",
    borderRadius: "6px",
    padding: compact ? "1px 2px" : "4px 6px",
    fontFamily: "system-ui, sans-serif",
    cursor: "pointer",
    flexShrink: 0,
  };

  return (
    <Box ref={boxRef} position="relative" w="100%">
      <Box display="flex" gap={1} alignItems="stretch">
        <Box
          as="button"
          flex="1"
          minW={0}
          textAlign="left"
          fontSize={compact ? "10px" : "12px"}
          fontFamily="system-ui, sans-serif"
          bg="surface2"
          color="ink"
          border="1px solid"
          borderColor={open ? "#7aa2f7" : "#3a4152"}
          borderRadius="6px"
          px={2}
          py={compact ? "2px" : "6px"}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label={ariaLabel ?? "model picker"}
          title={value === base ? display : value}
        >
          {display} <Text as="span" color="muted">▾</Text>
        </Box>
        {levels && (
          <select
            aria-label={`${ariaLabel ?? "model picker"} thinking level`}
            style={levelStyle}
            value={level ?? ""}
            onChange={(e) => onChange(e.target.value ? `${base}:${e.target.value}` : base)}
            title={`Thinking level (supported by ${base}) — "(default)" uses the node's configured level`}
          >
            <option value="">(default)</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
      </Box>
      {open && (
        <Box
          position="absolute"
          top="100%"
          left={0}
          right={0}
          mt={1}
          zIndex={30}
          bg="#1b1f2b"
          border="1px solid"
          borderColor="#7aa2f7"
          borderRadius="md"
          overflow="hidden"
          boxShadow="0 8px 30px rgba(0,0,0,0.5)"
          onClick={(e) => e.stopPropagation()}
        >
          <Box p={1}>
            <Input
              value={q}
              onChange={(e) => setQ((e.target as HTMLInputElement).value)}
              placeholder="Search Models…"
              size="xs"
              bg="#10131a"
              borderColor="#3a4152"
              color="ink"
              _placeholder={{ color: "#8b91a0" }}
              autoFocus
            />
          </Box>
          <Box maxH="220px" overflowY="auto" pb={1}>
            <PickerRow
              label="Auto (Provider Default)"
              active={!value || value === "auto"}
              onClick={() => pick("auto")}
            />
            {filtered.map((m) => (
              <PickerRow key={m.label} label={m.label} active={base === m.label} onClick={() => pick(m.label)} />
            ))}
            {filtered.length === 0 && (
              <Text fontSize="11px" color="muted" px={3} py={2} fontFamily="system-ui, sans-serif">
                No Matches
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function PickerRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      w="100%"
      textAlign="left"
      px={3}
      py={2}
      fontSize="12px"
      fontFamily="system-ui, sans-serif"
      bg={active ? "#232c44" : "transparent"}
      color={active ? "#7aa2f7" : "#e4e4e7"}
      onClick={onClick}
      _hover={{ bg: "#232c44" }}
      overflow="hidden"
      textOverflow="ellipsis"
      whiteSpace="nowrap"
      title={label}
    >
      {active ? "● " : ""}{label}
    </Box>
  );
}
