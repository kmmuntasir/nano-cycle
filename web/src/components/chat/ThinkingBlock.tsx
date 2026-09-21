import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Brain, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
}

export default function ThinkingBlock({ thinking, isStreaming }: ThinkingBlockProps) {
  // If streaming, default open; if finished, default collapsed
  const [open, setOpen] = useState(isStreaming ?? false);

  if (!thinking) return null;

  const lines = thinking.split("\n");
  const lineCount = lines.length;

  return (
    <Box
      my={2}
      borderRadius="md"
      border="1px solid"
      borderColor={isStreaming ? "accent" : "chatLine"}
      bg="chatInset"
      overflow="hidden"
      fontSize="12px"
    >
      <Flex
        as="button"
        w="100%"
        px={3}
        py={2}
        bg={isStreaming ? "rgba(122, 162, 247, 0.08)" : "chatHeader"}
        alignItems="center"
        justifyContent="space-between"
        cursor="pointer"
        border="none"
        textAlign="left"
        _hover={{ bg: "surface2" }}
        onClick={() => setOpen(!open)}
      >
        <Flex alignItems="center" gap={2}>
          {isStreaming ? (
            <Sparkles size={14} color="var(--chakra-colors-accent)" className="animate-spin" />
          ) : (
            <Brain size={14} color="var(--chakra-colors-muted)" />
          )}
          <Text
            fontSize="11px"
            fontWeight={600}
            color={isStreaming ? "accent" : "muted"}
            fontFamily="system-ui, sans-serif"
          >
            {isStreaming ? "Thinking..." : `Thought Process · ${lineCount} line${lineCount === 1 ? "" : "s"}`}
          </Text>
          {isStreaming && (
            <Box
              w="6px"
              h="6px"
              borderRadius="full"
              bg="accent"
              animation="pulse 1.5s infinite"
            />
          )}
        </Flex>

        <Box color="muted">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </Box>
      </Flex>

      {open && (
        <Box
          p={3}
          maxH="320px"
          overflowY="auto"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          fontSize="11.5px"
          lineHeight="1.5"
          color="muted"
          whiteSpace="pre-wrap"
          borderTop="1px solid"
          borderColor="chatLine"
          bg="chatCode"
        >
          {thinking}
        </Box>
      )}
    </Box>
  );
}
