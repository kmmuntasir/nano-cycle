import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import {
  Terminal,
  FileEdit,
  FileText,
  FilePlus,
  Search,
  FolderSearch,
  Folder,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import CodeDiffView from "./CodeDiffView";
import type { ChatToolCall } from "../../api";

interface ToolCallCardProps {
  toolCall: ChatToolCall;
  isStreaming?: boolean;
}

export default function ToolCallCard({ toolCall, isStreaming }: ToolCallCardProps) {
  const result = toolCall.result;
  const isRunning = isStreaming && !result;
  const isError = result?.isError ?? false;
  const isDone = !!result && !isError;

  // Collapsed by default — history stays compact; a running tool starts open.
  const [open, setOpen] = useState(!!isRunning);
  const [copied, setCopied] = useState(false);

  const name = toolCall.name;
  const args = toolCall.arguments || {};

  // Extract a nice one-line summary
  let targetSummary = "";
  if (name === "bash") {
    targetSummary = String(args.command ?? "");
  } else if (name === "edit" || name === "write" || name === "read") {
    targetSummary = String(args.path ?? "");
  } else if (name === "grep" || name === "find") {
    targetSummary = String(args.pattern ?? args.query ?? args.path ?? "");
  } else if (name === "ls") {
    targetSummary = String(args.path ?? "./");
  } else {
    targetSummary = JSON.stringify(args).slice(0, 80);
  }

  const getToolIcon = () => {
    switch (name) {
      case "bash":
        return <Terminal size={14} color="var(--chakra-colors-accent)" />;
      case "edit":
        return <FileEdit size={14} color="var(--chakra-colors-amber)" />;
      case "write":
        return <FilePlus size={14} color="var(--chakra-colors-good)" />;
      case "read":
        return <FileText size={14} color="var(--chakra-colors-muted)" />;
      case "grep":
        return <Search size={14} color="#bb9af7" />;
      case "find":
        return <FolderSearch size={14} color="#7dcfff" />;
      case "ls":
        return <Folder size={14} color="#ff9e64" />;
      default:
        return <Wrench size={14} color="var(--chakra-colors-muted)" />;
    }
  };

  const handleCopyContent = () => {
    const textToCopy = result?.content || JSON.stringify(args, null, 2);
    navigator.clipboard?.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const hasDiff = name === "edit" && (result?.details?.diff || result?.details?.patch);

  return (
    <Box
      my={2}
      borderRadius="md"
      border="1px solid"
      borderColor={isRunning ? "accent" : isError ? "bad" : "chatLine"}
      bg="chatInset"
      overflow="hidden"
      fontSize="12px"
    >
      {/* Header bar */}
      <Flex
        px={3}
        py={2}
        bg={isRunning ? "rgba(122, 162, 247, 0.07)" : isError ? "rgba(241, 106, 106, 0.08)" : "chatHeader"}
        alignItems="center"
        justifyContent="space-between"
        cursor="pointer"
        onClick={() => setOpen(!open)}
        _hover={{ bg: "surface2" }}
      >
        <Flex alignItems="center" gap={2} minW={0} flex={1} mr={2}>
          {getToolIcon()}
          <Box
            as="span"
            px={1.5}
            py={0.5}
            borderRadius="3px"
            bg="surface2"
            color="ink"
            fontSize="10.5px"
            fontFamily="ui-monospace, monospace"
            fontWeight={600}
          >
            {name}
          </Box>
          <Text
            fontSize="11.5px"
            fontFamily="ui-monospace, monospace"
            color="muted"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {targetSummary}
          </Text>
        </Flex>

        <Flex alignItems="center" gap={2}>
          {isRunning && (
            <Flex alignItems="center" gap={1} color="accent" fontSize="11px">
              <Loader2 size={12} className="animate-spin" />
              <span>Running</span>
            </Flex>
          )}
          {isDone && (
            <Flex alignItems="center" gap={1} color="good" fontSize="11px">
              <CheckCircle2 size={12} />
              <span>Done</span>
            </Flex>
          )}
          {isError && (
            <Flex alignItems="center" gap={1} color="bad" fontSize="11px">
              <XCircle size={12} />
              <span>Failed</span>
            </Flex>
          )}
          <Box color="muted">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </Box>
        </Flex>
      </Flex>

      {/* Expanded body */}
      {open && (
        <Box borderTop="1px solid" borderColor="chatLine">
          {/* If edit tool with diff */}
          {hasDiff ? (
            <Box p={2}>
              <CodeDiffView
                diff={String(result?.details?.diff ?? "")}
                patch={String(result?.details?.patch ?? "")}
                path={String(args.path ?? "")}
              />
              {result?.content && (
                <Text fontSize="11px" color="muted" mt={1} px={1}>
                  {result.content}
                </Text>
              )}
            </Box>
          ) : name === "bash" ? (
            /* Terminal view for bash */
            <Box bg="chatCode" p={3} fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">
              <Flex justifyContent="space-between" alignItems="center" mb={1.5}>
                <Flex alignItems="center" gap={1.5} color="good" fontSize="11.5px">
                  <Text as="span" color="accent">$</Text>
                  <Text as="span" color="ink">{String(args.command ?? "")}</Text>
                </Flex>
                {result?.content && (
                  <Box
                    as="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopyContent();
                    }}
                    display="flex"
                    alignItems="center"
                    gap={1}
                    fontSize="10.5px"
                    color={copied ? "good" : "muted"}
                    bg="transparent"
                    border="none"
                    cursor="pointer"
                    _hover={{ color: "ink" }}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? "Copied" : "Copy"}
                  </Box>
                )}
              </Flex>
              {result?.content ? (
                <Box
                  as="pre"
                  m={0}
                  p={2}
                  borderRadius="4px"
                  bg="chatCode"
                  border="1px solid"
                  borderColor="chatLine"
                  color="ink"
                  fontSize="11.5px"
                  lineHeight="1.4"
                  maxH="260px"
                  overflowY="auto"
                  whiteSpace="pre-wrap"
                >
                  {result.content}
                </Box>
              ) : isRunning ? (
                <Text fontSize="11px" color="muted" fontStyle="italic">
                  Command running in background...
                </Text>
              ) : null}
            </Box>
          ) : (
            /* Generic tool execution / read / write / grep / find / ls */
            <Box p={3} bg="chatInset">
              {/* Parameters info */}
              <Box mb={2} fontSize="11px" color="muted">
                <Text as="span" fontWeight={600} color="muted">Arguments: </Text>
                <Text as="span" fontFamily="ui-monospace, monospace" color="ink">
                  {JSON.stringify(args, null, 2)}
                </Text>
              </Box>

              {/* Tool output */}
              {result?.content ? (
                <Box>
                  <Flex justifyContent="space-between" alignItems="center" mb={1}>
                    <Text fontSize="11px" fontWeight={600} color="muted">
                      Output:
                    </Text>
                    <Box
                      as="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopyContent();
                      }}
                      display="flex"
                      alignItems="center"
                      gap={1}
                      fontSize="10.5px"
                      color={copied ? "good" : "muted"}
                      bg="transparent"
                      border="none"
                      cursor="pointer"
                      _hover={{ color: "ink" }}
                    >
                      {copied ? <Check size={11} /> : <Copy size={11} />}
                      {copied ? "Copied" : "Copy"}
                    </Box>
                  </Flex>
                  <Box
                    as="pre"
                    m={0}
                    p={2}
                    borderRadius="4px"
                    bg="chatCode"
                    border="1px solid"
                    borderColor="chatLine"
                    color={isError ? "bad" : "ink"}
                    fontSize="11.5px"
                    lineHeight="1.4"
                    maxH="260px"
                    overflowY="auto"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                    whiteSpace="pre-wrap"
                  >
                    {result.content}
                  </Box>
                </Box>
              ) : isRunning ? (
                <Text fontSize="11px" color="muted" fontStyle="italic">
                  Executing tool...
                </Text>
              ) : null}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
