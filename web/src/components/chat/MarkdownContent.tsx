import React, { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { marked, Tokens } from "marked";
import { Check, Copy } from "lucide-react";

interface MarkdownContentProps {
  content: string;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Box
      my={2.5}
      borderRadius="md"
      border="1px solid"
      borderColor="chatLine"
      bg="chatCard"
      overflow="hidden"
      fontSize="12px"
    >
      <Flex
        justifyContent="space-between"
        alignItems="center"
        px={3}
        py={1.5}
        bg="chatHeader"
        borderBottom="1px solid"
        borderColor="chatLine"
      >
        <Text
          fontSize="11px"
          fontFamily="ui-monospace, monospace"
          color="muted"
          textTransform="lowercase"
        >
          {lang || "text"}
        </Text>
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
          {copied ? "Copied" : "Copy"}
        </Box>
      </Flex>
      <Box
        as="pre"
        p={3}
        overflowX="auto"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
        color="ink"
        lineHeight="1.5"
        m={0}
        whiteSpace="pre"
      >
        <code>{code}</code>
      </Box>
    </Box>
  );
}

function renderInline(tokens?: Tokens.Generic[]): React.ReactNode {
  if (!tokens || tokens.length === 0) return null;

  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return <React.Fragment key={index}>{token.text}</React.Fragment>;
      case "strong":
        return (
          <Text as="strong" key={index} fontWeight={700} color="ink">
            {renderInline(token.tokens)}
          </Text>
        );
      case "em":
        return (
          <Text as="em" key={index} fontStyle="italic" color="ink">
            {renderInline(token.tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Box
            as="code"
            key={index}
            px={1.5}
            py={0.5}
            borderRadius="4px"
            bg="chatInset"
            color="amber"
            fontSize="0.88em"
            fontFamily="ui-monospace, monospace"
            border="1px solid var(--chakra-colors-chatLine)"
          >
            {token.text}
          </Box>
        );
      case "link":
        return (
          <Box
            as="a"
            key={index}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            color="accent"
            textDecoration="underline"
            _hover={{ color: "accent" }}
          >
            {renderInline(token.tokens)}
          </Box>
        );
      case "del":
        return (
          <Text as="del" key={index} textDecoration="line-through" color="muted">
            {renderInline(token.tokens)}
          </Text>
        );
      case "br":
        return <br key={index} />;
      default:
        return <React.Fragment key={index}>{token.raw ?? ""}</React.Fragment>;
    }
  });
}

function renderToken(token: Tokens.Generic, key: number | string): React.ReactNode {
  switch (token.type) {
    case "heading": {
      const sizes: Record<number, { fontSize: string; mt: number; mb: number }> = {
        1: { fontSize: "19px", mt: 4, mb: 2 },
        2: { fontSize: "16px", mt: 3.5, mb: 2 },
        3: { fontSize: "14px", mt: 3, mb: 1.5 },
        4: { fontSize: "13px", mt: 2.5, mb: 1 },
        5: { fontSize: "12px", mt: 2, mb: 1 },
        6: { fontSize: "12px", mt: 2, mb: 1 },
      };
      const style = sizes[token.depth] || sizes[3];
      return (
        <Text
          key={key}
          fontSize={style.fontSize}
          fontWeight={700}
          mt={style.mt}
          mb={style.mb}
          color="ink"
          lineHeight="1.3"
          fontFamily="system-ui, sans-serif"
        >
          {renderInline(token.tokens)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text
          key={key}
          fontSize="13px"
          lineHeight="1.6"
          mb={2}
          color="ink"
          fontFamily="system-ui, sans-serif"
        >
          {renderInline(token.tokens)}
        </Text>
      );
    case "code":
      return <CodeBlock key={key} lang={token.lang ?? ""} code={token.text ?? ""} />;
    case "blockquote":
      return (
        <Box
          key={key}
          borderLeft="3px solid var(--chakra-colors-accent)"
          bg="rgba(122, 162, 247, 0.06)"
          pl={3}
          py={1}
          my={2}
          borderRadius="0 4px 4px 0"
          color="ink"
          fontSize="13px"
        >
          {token.tokens?.map((t: Tokens.Generic, i: number) => renderToken(t, i))}
        </Box>
      );
    case "list": {
      const isOrdered = token.ordered;
      const Tag = isOrdered ? "ol" : "ul";
      return (
        <Box
          as={Tag}
          key={key}
          pl={5}
          my={2}
          fontSize="13px"
          lineHeight="1.5"
          color="ink"
        >
          {token.items?.map((item: Tokens.ListItem, i: number) => {
            const isTask = item.task;
            return (
              <Box as="li" key={i} mb={1} listStyleType={isTask ? "none" : undefined} ml={isTask ? -4 : 0}>
                {isTask ? (
                  <Flex alignItems="center" gap={1.5} as="span">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      readOnly
                      style={{ accentColor: "var(--chakra-colors-accent)", cursor: "default" }}
                    />
                    <Box as="span" textDecoration={item.checked ? "line-through" : "none"} color={item.checked ? "muted" : "inherit"}>
                      {item.tokens?.map((t: Tokens.Generic, j: number) => renderToken(t, j))}
                    </Box>
                  </Flex>
                ) : (
                  item.tokens?.map((t: Tokens.Generic, j: number) => renderToken(t, j))
                )}
              </Box>
            );
          })}
        </Box>
      );
    }
    case "table": {
      return (
        <Box key={key} my={2.5} overflowX="auto" borderRadius="md" border="1px solid var(--chakra-colors-chatLine)">
          <Box as="table" w="100%" fontSize="12px" borderCollapse="collapse">
            <Box as="thead" bg="chatHeader">
              <Box as="tr">
                {token.header?.map((cell: Tokens.TableCell, i: number) => (
                  <Box
                    as="th"
                    key={i}
                    px={3}
                    py={2}
                    textAlign={cell.align || "left"}
                    fontWeight={700}
                    color="ink"
                    borderBottom="1px solid var(--chakra-colors-chatLine)"
                  >
                    {renderInline(cell.tokens)}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box as="tbody">
              {token.rows?.map((row: Tokens.TableCell[], rowIndex: number) => (
                <Box
                  as="tr"
                  key={rowIndex}
                  bg={rowIndex % 2 === 0 ? "chatCard" : "chatInset"}
                  _hover={{ bg: "surface2" }}
                >
                  {row.map((cell: Tokens.TableCell, cellIndex: number) => (
                    <Box
                      as="td"
                      key={cellIndex}
                      px={3}
                      py={1.5}
                      textAlign={cell.align || "left"}
                      borderBottom="1px solid var(--chakra-colors-chatLine)"
                      color="ink"
                    >
                      {renderInline(cell.tokens)}
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      );
    }
    case "hr":
      return <Box key={key} as="hr" my={3} border="none" borderTop="1px solid var(--chakra-colors-chatLine)" />;
    case "space":
      return null;
    default:
      return (
        <Text key={key} fontSize="13px" color="ink" mb={1}>
          {token.raw ?? ""}
        </Text>
      );
  }
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  if (!content) return null;

  try {
    const tokens = marked.lexer(content);
    return (
      <Box className="chat-markdown" lineHeight="1.5">
        {tokens.map((token, index) => renderToken(token, index))}
      </Box>
    );
  } catch {
    return (
      <Box whiteSpace="pre-wrap" fontSize="13px" color="ink" fontFamily="system-ui, sans-serif">
        {content}
      </Box>
    );
  }
}
