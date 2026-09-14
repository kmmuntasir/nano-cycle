import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Text } from "@chakra-ui/react";
import type { ModelInfo } from "../api";

/** Searchable model dropdown — native <select> can't filter a long model list. */
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

  const display = !value || value === "auto" ? "Auto (Provider Default)" : value;

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };

  return (
    <Box ref={boxRef} position="relative" w="100%">
      <Box
        as="button"
        w="100%"
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
        title={display}
      >
        {display} <Text as="span" color="muted">▾</Text>
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
              <PickerRow key={m.label} label={m.label} active={value === m.label} onClick={() => pick(m.label)} />
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
