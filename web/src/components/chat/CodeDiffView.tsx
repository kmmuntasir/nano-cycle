import { useMemo, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Check, Copy, FileCode2, ChevronDown, ChevronUp } from "lucide-react";

interface CodeDiffViewProps {
  diff?: string;
  patch?: string;
  path?: string;
}

interface ParsedLine {
  type: "add" | "del" | "context" | "header" | "meta";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export default function CodeDiffView({ diff, patch, path }: CodeDiffViewProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const raw = diff || patch || "";

  const { lines, adds, dels, detectedPath } = useMemo(() => {
    const rawLines = raw.split("\n");
    const result: ParsedLine[] = [];
    let curOld = 1;
    let curNew = 1;
    let countAdds = 0;
    let countDels = 0;
    let filePath = path || "";

    for (const line of rawLines) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        if (!filePath) {
          const match = line.slice(4).trim().replace(/^[ab]\//, "");
          if (match && match !== "/dev/null") filePath = match;
        }
        result.push({ type: "meta", oldLine: null, newLine: null, text: line });
        continue;
      }

      if (line.startsWith("@@")) {
        // Chunk header: @@ -start,count +start,count @@
        const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (m) {
          curOld = parseInt(m[1], 10);
          curNew = parseInt(m[2], 10);
        }
        result.push({ type: "header", oldLine: null, newLine: null, text: line });
        continue;
      }

      if (line.startsWith("+")) {
        countAdds++;
        result.push({
          type: "add",
          oldLine: null,
          newLine: curNew++,
          text: line.slice(1),
        });
      } else if (line.startsWith("-")) {
        countDels++;
        result.push({
          type: "del",
          oldLine: curOld++,
          newLine: null,
          text: line.slice(1),
        });
      } else if (line.startsWith(" ")) {
        result.push({
          type: "context",
          oldLine: curOld++,
          newLine: curNew++,
          text: line.slice(1),
        });
      } else if (line.trim().length > 0) {
        // Fallback line
        result.push({
          type: "context",
          oldLine: null,
          newLine: null,
          text: line,
        });
      }
    }

    return { lines: result, adds: countAdds, dels: countDels, detectedPath: filePath };
  }, [raw, path]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const isLong = lines.length > 35;
  const visibleLines = isLong && !expanded ? lines.slice(0, 30) : lines;

  if (!raw.trim()) {
    return (
      <Box p={2} fontSize="11px" color="muted" fontStyle="italic">
        No diff output recorded
      </Box>
    );
  }

  return (
    <Box
      my={2}
      borderRadius="md"
      border="1px solid"
      borderColor="chatLine"
      bg="chatInset"
      overflow="hidden"
      fontSize="12px"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    >
      {/* Header bar */}
      <Flex
        px={3}
        py={2}
        bg="chatHeader"
        borderBottom="1px solid"
        borderColor="chatLine"
        justifyContent="space-between"
        alignItems="center"
      >
        <Flex alignItems="center" gap={2} minW={0}>
          <FileCode2 size={14} color="var(--chakra-colors-accent)" />
          <Text
            fontSize="12px"
            fontWeight={600}
            color="ink"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {detectedPath || "Diff"}
          </Text>
          <Flex gap={1} ml={1}>
            {adds > 0 && (
              <Box
                as="span"
                px={1.5}
                py={0.2}
                borderRadius="3px"
                bg="rgba(79, 214, 168, 0.15)"
                color="#4fd6a8"
                fontSize="10px"
                fontWeight={700}
              >
                +{adds}
              </Box>
            )}
            {dels > 0 && (
              <Box
                as="span"
                px={1.5}
                py={0.2}
                borderRadius="3px"
                bg="rgba(241, 106, 106, 0.15)"
                color="#f16a6a"
                fontSize="10px"
                fontWeight={700}
              >
                -{dels}
              </Box>
            )}
          </Flex>
        </Flex>

        <Box
          as="button"
          onClick={handleCopy}
          display="flex"
          alignItems="center"
          gap={1}
          fontSize="11px"
          color={copied ? "good" : "muted"}
          bg="transparent"
          border="none"
          cursor="pointer"
          _hover={{ color: "ink" }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy Diff"}
        </Box>
      </Flex>

      {/* Diff line viewer */}
      <Box overflowX="auto" py={1}>
        <Box as="table" w="100%" borderCollapse="collapse" lineHeight="1.5">
          <Box as="tbody">
            {visibleLines.map((l, i) => {
              const isAdd = l.type === "add";
              const isDel = l.type === "del";
              const isHdr = l.type === "header";
              const isMeta = l.type === "meta";

              let bg = "transparent";
              let textColor = "ink";
              if (isAdd) {
                bg = "rgba(79, 214, 168, 0.12)";
                textColor = "good";
              } else if (isDel) {
                bg = "rgba(241, 106, 106, 0.12)";
                textColor = "bad";
              } else if (isHdr) {
                bg = "rgba(122, 162, 247, 0.08)";
                textColor = "accent";
              } else if (isMeta) {
                textColor = "muted";
              }

              return (
                <Box as="tr" key={i} bg={bg}>
                  {/* Old line number */}
                  <Box
                    as="td"
                    w="36px"
                    textAlign="right"
                    pr={1.5}
                    pl={2}
                    color="muted"
                    userSelect="none"
                    fontSize="11px"
                  >
                    {l.oldLine ?? ""}
                  </Box>
                  {/* New line number */}
                  <Box
                    as="td"
                    w="36px"
                    textAlign="right"
                    pr={2}
                    pl={1}
                    color="muted"
                    userSelect="none"
                    fontSize="11px"
                    borderRight="1px solid"
                    borderColor="chatLine"
                  >
                    {l.newLine ?? ""}
                  </Box>
                  {/* Sign symbol */}
                  <Box
                    as="td"
                    w="18px"
                    textAlign="center"
                    userSelect="none"
                    color={textColor}
                    fontWeight={700}
                    pl={1}
                  >
                    {isAdd ? "+" : isDel ? "-" : isHdr ? "@" : " "}
                  </Box>
                  {/* Text */}
                  <Box
                    as="td"
                    pr={3}
                    color={textColor}
                    whiteSpace="pre"
                    fontStyle={isHdr ? "italic" : undefined}
                  >
                    {l.text}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Expand / collapse button if long */}
      {isLong && (
        <Box
          as="button"
          w="100%"
          py={1.5}
          bg="chatHeader"
          borderTop="1px solid"
          borderColor="chatLine"
          color="accent"
          fontSize="11px"
          cursor="pointer"
          display="flex"
          alignItems="center"
          justifyContent="center"
          gap={1}
          _hover={{ bg: "surface2" }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} /> Show all {lines.length} lines ({lines.length - 30} more)
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
