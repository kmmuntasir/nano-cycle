import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { GhostButton } from "../ui/buttons";
import { pretty } from "../lib/format";
import type { RunState } from "../api";

function groupOf(name: string, kind: string): string {
  if (kind === "input") return "Inputs";
  const n = name.toLowerCase();
  if (n.includes("spec") || n.includes("clarif")) return "Spec";
  if (n.includes("plan")) return "Plans";
  if (n.includes("verif")) return "Verify";
  return "Outputs";
}

export default function Workbench({ state }: { state: RunState }) {
  const files = useMemo(() => {
    const out: { name: string; kind: "artifact" | "input"; content: string; group: string }[] = [];
    for (const [k, v] of Object.entries(state.artifacts ?? {})) {
      out.push({ name: k, kind: "artifact", content: pretty(v), group: groupOf(k, "artifact") });
    }
    for (const [k, v] of Object.entries(state.prompts ?? {})) {
      out.push({ name: `input:${k}`, kind: "input", content: v, group: groupOf(k, "input") });
    }
    const order = ["Spec", "Plans", "Outputs", "Verify", "Inputs"];
    return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
  }, [state.artifacts, state.prompts]);

  const [activeName, setActiveName] = useState<string | null>(null);
  useEffect(() => {
    if (!activeName || !files.some((f) => f.name === activeName)) {
      // Prefer newest artifact, keep selection stable otherwise.
      const lastArtifact = [...files].reverse().find((f) => f.kind === "artifact");
      setActiveName((lastArtifact ?? files[0])?.name ?? null);
    }
  }, [files, activeName]);

  if (files.length === 0) {
    return (
      <Box border="1px dashed" borderColor="line" borderRadius="md" p={6} textAlign="center">
        <Text fontSize="13px" fontFamily="system-ui, sans-serif">No Artifacts Yet</Text>
        <Text fontSize="11px" color="#c9cdd8" fontFamily="system-ui, sans-serif">They appear here as nodes complete — prompts under Inputs.</Text>
      </Box>
    );
  }
  const file = files.find((f) => f.name === activeName) ?? files[0];
  const groups = [...new Set(files.map((f) => f.group))];

  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" overflow="hidden">
      <Flex bg="surface2" px={3} py={2} alignItems="center" gap={2}>
        <Text fontSize="10px" color="#c9cdd8" letterSpacing="widest" fontFamily="system-ui, sans-serif">
          Artifacts · {files.filter((f) => f.kind === "artifact").length} + {files.filter((f) => f.kind === "input").length} Inputs
        </Text>
        <Box flex="1" />
        <GhostButton onClick={() => navigator.clipboard?.writeText(file.content).catch(() => {})}>
          Copy
        </GhostButton>
      </Flex>
      <Flex>
        <Box w="200px" flexShrink={0} borderRight="1px solid" borderColor="line" bg="#10131a" minH="280px" maxH="52vh" overflowY="auto">
          {groups.map((g) => (
            <Box key={g}>
              <Text fontSize="10px" color="muted" px={3} pt={2} fontFamily="system-ui, sans-serif">{g}</Text>
              {files.filter((f) => f.group === g).map((f) => {
                const selected = f.name === file.name;
                return (
                  <Box
                    key={f.name}
                    px={3}
                    py={2}
                    fontSize="11px"
                    cursor="pointer"
                    bg={selected ? "#1b2130" : "transparent"}
                    color={selected ? "#7aa2f7" : "#8b91a0"}
                    borderLeft="2px solid"
                    borderLeftColor={selected ? "#7aa2f7" : "transparent"}
                    onClick={() => setActiveName(f.name)}
                    _hover={{ color: "#e4e4e7" }}
                    overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap"
                    fontFamily="ui-monospace, monospace"
                    title={f.name}
                  >
                    {f.kind === "input" ? "⌨ " : "📄 "}
                    {f.name.replace(/^input:/, "")}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
        <Box flex="1" minW={0} p={3} maxH="52vh" overflowY="auto">
          <Text fontSize="10px" color="muted" mb={2} fontFamily="ui-monospace, monospace">
            {file.name} · {file.content.length} chars
          </Text>
          <Box as="pre" fontSize="12px" whiteSpace="pre-wrap" m={0} fontFamily="ui-monospace, monospace">
            {file.content}
          </Box>
        </Box>
      </Flex>
    </Box>
  );
}
