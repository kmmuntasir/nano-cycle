import { useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { pretty } from "../lib/format";
import type { RunState } from "../api";

/**
 * VS Code-style workbench: a narrow "file" sidebar (artifacts + node input
 * prompts) on the left, content pane on the right.
 */
export default function Workbench({ state }: { state: RunState }) {
  const files: { name: string; kind: "artifact" | "input"; content: string }[] = [];
  for (const [k, v] of Object.entries(state.artifacts ?? {})) {
    files.push({ name: k, kind: "artifact", content: pretty(v) });
  }
  for (const [k, v] of Object.entries(state.prompts ?? {})) {
    files.push({ name: `input:${k}`, kind: "input", content: v });
  }

  const [active, setActive] = useState(0);
  if (files.length === 0) {
    return (
      <Text fontSize="xs" color="muted">
        No artifacts yet — they appear as nodes complete.
      </Text>
    );
  }
  const file = files[Math.min(active, files.length - 1)];

  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" overflow="hidden">
      <Flex bg="surface2" px={2} py={1} alignItems="center" gap={2}>
        <Text fontSize="10px" color="muted" letterSpacing="widest">
          WORKBENCH
        </Text>
      </Flex>
      <Flex>
        <Box
          w="180px"
          flexShrink={0}
          borderRight="1px solid"
          borderColor="line"
          bg="#10131a"
          minH="220px"
        >
          {files.map((f, i) => {
            const selected = i === Math.min(active, files.length - 1);
            return (
              <Box
                key={f.name}
                px={3}
                py={2}
                fontSize="11px"
                cursor="pointer"
                bg={selected ? "#1b2130" : "transparent"}
                color={selected ? "accent" : "muted"}
                borderLeft="2px solid"
                borderLeftColor={selected ? "accent" : "transparent"}
                onClick={() => setActive(i)}
                _hover={{ color: "ink" }}
              >
                {f.kind === "input" ? "⌨ " : "📄 "}
                {f.name}
              </Box>
            );
          })}
        </Box>
        <Box flex="1" minW={0} p={3} maxH="46vh" overflowY="auto">
          <Text fontSize="10px" color="muted" mb={2}>
            {file.name}
          </Text>
          <Box as="pre" fontSize="12px" whiteSpace="pre-wrap" m={0}>
            {file.content}
          </Box>
        </Box>
      </Flex>
    </Box>
  );
}
