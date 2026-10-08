import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import {
  Send,
  Square,
  Plus,
  Trash2,
  Edit2,
  Bot,
  User,
  Search,
  Sparkles,
  ArrowDown,
  Terminal,
  FileCode,
  CheckCircle,
  Menu,
  X,
} from "lucide-react";
import MarkdownContent from "./chat/MarkdownContent";
import ThinkingBlock from "./chat/ThinkingBlock";
import ToolCallCard from "./chat/ToolCallCard";
import ConfirmDialog from "./ConfirmDialog";
import ModelPicker from "../ui/ModelPicker";
import { SelectEl } from "../ui/controls";
import { BELOW_HEADER_H } from "../ui/layout";
import { chatApi } from "../api";
import type {
  ChatEventMessage,
  ChatMessage,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatToolCall,
  ModelInfo,
  WsMessage,
} from "../api";

interface ChatViewProps {
  project: string;
  models: ModelInfo[];
}

// Group sessions by date
function groupSessions(sessions: ChatSessionSummary[]) {
  const today: ChatSessionSummary[] = [];
  const yesterday: ChatSessionSummary[] = [];
  const pastWeek: ChatSessionSummary[] = [];
  const older: ChatSessionSummary[] = [];

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 86400000 * 7;

  for (const s of sessions) {
    const time = s.modifiedAt ? new Date(s.modifiedAt).getTime() : 0;
    if (time >= todayStart) today.push(s);
    else if (time >= yesterdayStart) yesterday.push(s);
    else if (time >= weekStart) pastWeek.push(s);
    else older.push(s);
  }

  return [
    { title: "Today", items: today },
    { title: "Yesterday", items: yesterday },
    { title: "Previous 7 Days", items: pastWeek },
    { title: "Older", items: older },
  ].filter((g) => g.items.length > 0);
}

function formatTime(isoOrTs?: string | number | null) {
  if (!isoOrTs) return "";
  const d = new Date(isoOrTs);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const readModel = (p: string) => localStorage.getItem(`nano-chat-model-${p}`) || localStorage.getItem("nano-chat-model") || "auto";
const readThinking = (p: string) => localStorage.getItem(`nano-chat-thinking-${p}`) || "medium";

export default function ChatView({ project, models }: ChatViewProps) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ChatSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [inputPrompt, setInputPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Streaming state for the active turn
  const [streamThinking, setStreamThinking] = useState("");
  const [streamText, setStreamText] = useState("");
  const [streamToolCalls, setStreamToolCalls] = useState<ChatToolCall[]>([]);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);

  // Model & Thinking level selections (remembered per project)
  const [selectedModel, setSelectedModel] = useState<string>(() => readModel(project));
  const [thinkingLevel, setThinkingLevel] = useState<string>(() => readThinking(project));

  // Rename & Delete dialogs
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");

  // Auto-scroll
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Persist only on a user pick, under the project it was picked in. (An effect
  // keyed on [selectedModel, project] used to run on a project switch with the
  // PREVIOUS project's model still in state and write it into the new
  // project's key.) A session's own model, applied by loadSession, is not a pick.
  const pickModel = (m: string) => {
    setSelectedModel(m);
    if (!m) return;
    localStorage.setItem(`nano-chat-model-${project}`, m);
    localStorage.setItem("nano-chat-model", m);
  };
  const pickThinking = (l: string) => {
    setThinkingLevel(l);
    if (l) localStorage.setItem(`nano-chat-thinking-${project}`, l);
  };

  const projectRef = useRef(project);
  projectRef.current = project;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeSessionId;
  // Increments on every session load / project switch: a slower response for
  // a session or project the user has left must not overwrite the current view.
  const loadSeq = useRef(0);

  // Streamed deltas are buffered and applied once per animation frame — one
  // markdown re-render per frame instead of one per token.
  const thinkBuf = useRef("");
  const textBuf = useRef("");
  const rafId = useRef<number | null>(null);
  const flushStream = useCallback(() => {
    rafId.current = null;
    const th = thinkBuf.current;
    const tx = textBuf.current;
    thinkBuf.current = "";
    textBuf.current = "";
    if (th) setStreamThinking((prev) => prev + th);
    if (tx) setStreamText((prev) => prev + tx);
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafId.current === null) rafId.current = requestAnimationFrame(flushStream);
  }, [flushStream]);
  const dropStreamBuffers = useCallback(() => {
    thinkBuf.current = "";
    textBuf.current = "";
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
  }, []);
  useEffect(() => dropStreamBuffers, [dropStreamBuffers]);

  // Load session list on project change
  const refreshSessions = useCallback(async () => {
    try {
      const list = await chatApi.listSessions(project);
      if (projectRef.current !== project) return [];
      setSessions(list);
      return list;
    } catch {
      return [];
    }
  }, [project]);

  const loadSession = async (sessionId: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const detail = await chatApi.getSession(project, sessionId);
      if (seq !== loadSeq.current) return;
      setActiveSessionId(sessionId);
      setActiveSession(detail);
      setIsGenerating(detail.isGenerating);
      if (detail.model) setSelectedModel(detail.model);
      if (detail.thinkingLevel) setThinkingLevel(detail.thinkingLevel);
      // Reset stream buffers
      dropStreamBuffers();
      setStreamThinking("");
      setStreamText("");
      setStreamToolCalls([]);
      setStreamStatus(null);
    } catch (e) {
      if (seq === loadSeq.current) console.error("Failed to load session:", e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  // Project switch: drop the old project's conversation and its remembered
  // picks, then open the new project's latest session.
  useEffect(() => {
    let cancelled = false;
    ++loadSeq.current;
    setSelectedModel(readModel(project));
    setThinkingLevel(readThinking(project));
    setActiveSessionId(null);
    setActiveSession(null);
    setIsGenerating(false);
    setSessions([]);
    dropStreamBuffers();
    setStreamThinking("");
    setStreamText("");
    setStreamToolCalls([]);
    setStreamStatus(null);
    refreshSessions().then((list) => {
      if (cancelled) return;
      if (list.length > 0) {
        // Pick latest session
        loadSession(list[0].id);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, refreshSessions]);

  const handleCreateSession = async () => {
    try {
      const newSession = await chatApi.createSession(project, {
        modelSpec: selectedModel,
        thinkingLevel,
      });
      await refreshSessions();
      await loadSession(newSession.id);
      setInputPrompt("");
      textareaRef.current?.focus();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return;
    try {
      await chatApi.deleteSession(project, sessionToDelete);
      const updated = await refreshSessions();
      if (activeSessionId === sessionToDelete) {
        if (updated.length > 0) {
          await loadSession(updated[0].id);
        } else {
          setActiveSessionId(null);
          setActiveSession(null);
        }
      }
    } catch (e) {
      alert(String(e));
    } finally {
      setSessionToDelete(null);
    }
  };

  const handleRenameSubmit = async (sessionId: string) => {
    if (!renameTitle.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await chatApi.renameSession(project, sessionId, renameTitle.trim());
      await refreshSessions();
      if (activeSession && activeSession.id === sessionId) {
        setActiveSession({ ...activeSession, title: renameTitle.trim() });
      }
    } catch (e) {
      alert(String(e));
    } finally {
      setRenamingId(null);
      setRenameTitle("");
    }
  };

  // Scroll logic
  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 120;
    setShowScrollBottom(!atBottom);
  };

  useEffect(() => {
    if (!showScrollBottom) {
      scrollToBottom(false);
    }
  }, [activeSession?.messages, streamText, streamThinking, streamToolCalls, showScrollBottom, scrollToBottom]);

  // WebSocket message handler
  useEffect(() => {
    const handleWs = (e: Event) => {
      const msg = (e as CustomEvent<WsMessage>).detail;
      if (msg.type === "ws-reconnected") {
        // Deltas were missed while the socket was down: re-read the session.
        const sid = activeIdRef.current;
        refreshSessions();
        if (sid) {
          const seq = loadSeq.current;
          chatApi
            .getSession(project, sid)
            .then((d) => {
              if (seq !== loadSeq.current || activeIdRef.current !== sid) return;
              setActiveSession(d);
              setIsGenerating(d.isGenerating);
              if (!d.isGenerating) {
                dropStreamBuffers();
                setStreamThinking("");
                setStreamText("");
                setStreamToolCalls([]);
                setStreamStatus(null);
              }
            })
            .catch(() => {});
        }
        return;
      }
      if (msg.type !== "chat_event") return;
      if (msg.project !== project) return;
      if (activeSessionId && msg.sessionId !== activeSessionId) return;

      const ev = msg as unknown as ChatEventMessage;

      switch (ev.event) {
        case "prompt_start": {
          dropStreamBuffers();
          setIsGenerating(true);
          setStreamThinking("");
          setStreamText("");
          setStreamToolCalls([]);
          setStreamStatus("Thinking...");
          break;
        }
        case "thinking_delta": {
          if (ev.delta) {
            thinkBuf.current += ev.delta;
            scheduleFlush();
            setStreamStatus("Thinking...");
          }
          break;
        }
        case "text_delta": {
          if (ev.delta) {
            textBuf.current += ev.delta;
            scheduleFlush();
            setStreamStatus("Generating response...");
          }
          break;
        }
        case "tool_start": {
          const toolCall: ChatToolCall = {
            id: ev.toolCallId ?? `call_${Date.now()}`,
            name: ev.toolName ?? "tool",
            arguments: (ev.args as Record<string, unknown>) ?? {},
            result: null,
          };
          setStreamToolCalls((prev) => [...prev, toolCall]);
          setStreamStatus(`Executing ${ev.toolName ?? "tool"}...`);
          break;
        }
        case "tool_end": {
          setStreamToolCalls((prev) =>
            prev.map((tc) => {
              if (tc.id === ev.toolCallId || (!tc.result && tc.name === ev.toolName)) {
                return {
                  ...tc,
                  result: {
                    toolCallId: tc.id,
                    toolName: tc.name,
                    isError: !ev.ok,
                    content: ev.content ?? "",
                    details: (ev.details as Record<string, unknown>) ?? null,
                    timestamp: Date.now(),
                  },
                };
              }
              return tc;
            }),
          );
          setStreamStatus("Processing result...");
          break;
        }
        case "turn_end": {
          break;
        }
        case "prompt_end":
        case "done": {
          setIsGenerating(false);
          setStreamStatus(null);
          // Reload fresh session history from server
          if (activeSessionId) {
            const sid = activeSessionId;
            chatApi.getSession(project, sid).then((updated) => {
              if (activeIdRef.current !== sid) return;
              dropStreamBuffers();
              setActiveSession(updated);
              setStreamThinking("");
              setStreamText("");
              setStreamToolCalls([]);
            }).catch(() => {});
            refreshSessions();
          }
          break;
        }
        case "session_renamed": {
          refreshSessions();
          if (activeSession && activeSession.id === ev.sessionId && ev.title) {
            setActiveSession((prev) => (prev ? { ...prev, title: ev.title! } : null));
          }
          break;
        }
        case "error": {
          setIsGenerating(false);
          setStreamStatus(null);
          if (activeSessionId) {
            chatApi.getSession(project, activeSessionId).then(setActiveSession).catch(() => {});
          }
          break;
        }
        case "aborted": {
          setIsGenerating(false);
          setStreamStatus(null);
          if (activeSessionId) {
            chatApi.getSession(project, activeSessionId).then(setActiveSession).catch(() => {});
          }
          break;
        }
      }
    };

    window.addEventListener("nano-ws", handleWs);
    return () => window.removeEventListener("nano-ws", handleWs);
  }, [project, activeSessionId, activeSession, refreshSessions, scheduleFlush, dropStreamBuffers]);

  const handleSendMessage = async (promptToSend?: string) => {
    const text = (promptToSend ?? inputPrompt).trim();
    if (!text || isGenerating) return;

    let targetSessionId = activeSessionId;

    // If no active session, create one first
    if (!targetSessionId) {
      try {
        const newSession = await chatApi.createSession(project, {
          modelSpec: selectedModel,
          thinkingLevel,
        });
        targetSessionId = newSession.id;
        setActiveSessionId(newSession.id);
        await refreshSessions();
      } catch (e) {
        alert(String(e));
        return;
      }
    }

    // Immediately reflect user message in local view for instant feel
    const userMsg: ChatMessage = {
      id: `temp_user_${Date.now()}`,
      role: "user",
      timestamp: Date.now(),
      content: text,
    };

    setActiveSession((prev) => {
      if (!prev) {
        return {
          id: targetSessionId!,
          file: "",
          title: text.slice(0, 40),
          model: selectedModel,
          thinkingLevel,
          messages: [userMsg],
          isGenerating: true,
        };
      }
      return {
        ...prev,
        messages: [...prev.messages, userMsg],
        isGenerating: true,
      };
    });

    setInputPrompt("");
    dropStreamBuffers();
    setIsGenerating(true);
    setStreamThinking("");
    setStreamText("");
    setStreamToolCalls([]);
    setStreamStatus("Thinking...");

    try {
      await chatApi.sendMessage(project, targetSessionId, {
        prompt: text,
        modelSpec: selectedModel,
        thinkingLevel,
      });
    } catch (e) {
      setIsGenerating(false);
      setStreamStatus(null);
      alert(String(e));
    }
  };

  const handleAbort = async () => {
    if (!activeSessionId) return;
    try {
      await chatApi.abort(project, activeSessionId);
    } catch (e) {
      console.error("Error aborting session:", e);
    } finally {
      setIsGenerating(false);
      setStreamStatus(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Filtered sessions
  const filteredSessions = searchQuery.trim()
    ? sessions.filter(
        (s) =>
          (s.name && s.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (s.firstMessage && s.firstMessage.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : sessions;

  const grouped = groupSessions(filteredSessions);

  // Calculate total session tokens
  const totalTokens = (activeSession?.messages || []).reduce(
    (acc, m) => {
      if (m.usage) {
        acc.input += m.usage.input || 0;
        acc.output += m.usage.output || 0;
        acc.cacheRead += m.usage.cacheRead || 0;
        acc.total += m.usage.total || 0;
      }
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, total: 0 },
  );

  return (
    <Box h={BELOW_HEADER_H} display="flex" bg="canvas" overflow="hidden" position="relative">
      {/* tap-outside backdrop for the phone drawer */}
      {mobileSidebarOpen && (
        <Box
          display={{ base: "block", md: "none" }}
          position="absolute"
          inset={0}
          zIndex={19}
          bg="rgba(0,0,0,0.5)"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      {/* Left Sidebar (Desktop & Mobile Drawer) */}
      <Box
        w={{ base: mobileSidebarOpen ? "280px" : "0", md: "260px", lg: "280px" }}
        transition="all 0.2s ease"
        bg="chatPanel"
        borderRight="1px solid"
        borderColor="chatLine"
        display={{ base: mobileSidebarOpen ? "flex" : "none", md: "flex" }}
        flexDirection="column"
        flexShrink={0}
        zIndex={20}
        position={{ base: "absolute", md: "relative" }}
        h="100%"
      >
        {/* Sidebar Header */}
        <Box p={3} borderBottom="1px solid var(--chakra-colors-chatLine)">
          <Flex justifyContent="space-between" alignItems="center" mb={2}>
            <Text fontSize="11px" fontWeight={700} color="muted" letterSpacing="0.05em" textTransform="uppercase">
              Chats · {sessions.length}
            </Text>
            {mobileSidebarOpen && (
              <Box
                as="button"
                display={{ base: "flex", md: "none" }}
                alignItems="center"
                justifyContent="center"
                w="40px"
                h="40px"
                mr="-8px"
                color="muted"
                aria-label="Close chat list"
                onClick={() => setMobileSidebarOpen(false)}
              >
                <X size={18} />
              </Box>
            )}
          </Flex>

          <Box
            as="button"
            w="100%"
            py={2}
            px={3}
            borderRadius="md"
            bg="accent"
            color="onAccent"
            fontWeight={600}
            fontSize="12.5px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            gap={2}
            cursor="pointer"
            _hover={{ bg: "#89b4fa" }}
            onClick={handleCreateSession}
          >
            <Plus size={15} />
            <span>New Chat</span>
          </Box>

          {/* Search box */}
          <Flex
            mt={2.5}
            alignItems="center"
            gap={1.5}
            px={2.5}
            py={1.5}
            borderRadius="md"
            bg="chatInput"
            border="1px solid var(--chakra-colors-chatLine)"
          >
            <Search size={13} color="var(--chakra-colors-muted)" />
            <input
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: "11.5px",
                color: "var(--chakra-colors-ink)",
                width: "100%",
              }}
            />
          </Flex>
        </Box>

        {/* Sessions list */}
        <Box flex={1} overflowY="auto" p={2}>
          {grouped.length === 0 ? (
            <Box p={4} textAlign="center" color="muted" fontSize="12px">
              {searchQuery ? "No matching chats" : "No chats yet"}
            </Box>
          ) : (
            grouped.map((group) => (
              <Box key={group.title} mb={3}>
                <Text
                  px={2}
                  py={1}
                  fontSize="10px"
                  fontWeight={700}
                  color="muted"
                  letterSpacing="0.05em"
                  textTransform="uppercase"
                >
                  {group.title}
                </Text>

                {group.items.map((s) => {
                  const isActive = s.id === activeSessionId;
                  const isRenaming = renamingId === s.id;
                  const title = s.name || s.firstMessage || `Session ${s.id.slice(0, 8)}`;

                  return (
                    <Flex
                      key={s.id}
                      px={2.5}
                      py={2}
                      minH={{ base: "48px", md: "0" }}
                      my={0.5}
                      borderRadius="md"
                      bg={isActive ? "surface2" : "transparent"}
                      border="1px solid"
                      borderColor={isActive ? "chatLine" : "transparent"}
                      cursor="pointer"
                      alignItems="center"
                      justifyContent="space-between"
                      role="group"
                      _hover={{ bg: "surface2" }}
                      onClick={() => {
                        if (!isRenaming) {
                          loadSession(s.id);
                          setMobileSidebarOpen(false);
                        }
                      }}
                    >
                      <Box minW={0} flex={1} mr={1}>
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameTitle}
                            onChange={(e) => setRenameTitle(e.target.value)}
                            onBlur={() => handleRenameSubmit(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameSubmit(s.id);
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            style={{
                              background: "var(--chakra-colors-chatInset)",
                              border: "1px solid var(--chakra-colors-accent)",
                              borderRadius: "3px",
                              color: "var(--chakra-colors-ink)",
                              fontSize: "11.5px",
                              padding: "2px 4px",
                              width: "100%",
                            }}
                          />
                        ) : (
                          <>
                            <Text
                              fontSize="12px"
                              fontWeight={isActive ? 600 : 400}
                              color={isActive ? "accent" : "ink"}
                              whiteSpace="nowrap"
                              overflow="hidden"
                              textOverflow="ellipsis"
                            >
                              {title}
                            </Text>
                            <Flex alignItems="center" gap={1.5} mt={0.5}>
                              <Text fontSize="10px" color="muted">
                                {formatTime(s.modifiedAt || s.createdAt)}
                              </Text>
                              {s.messageCount > 0 && (
                                <Text fontSize="10px" color="muted">
                                  · {s.messageCount} msgs
                                </Text>
                              )}
                            </Flex>
                          </>
                        )}
                      </Box>

                      {/* Action buttons on hover */}
                      {!isRenaming && (
                        <Flex gap={1} display={{ base: "flex", md: "none" }} _groupHover={{ display: "flex" }}>
                          <Box
                            as="button"
                            p={{ base: 3, md: 1 }}
                            color="muted"
                            _hover={{ color: "accent" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingId(s.id);
                              setRenameTitle(s.name || s.firstMessage || "");
                            }}
                            title="Rename"
                          >
                            <Edit2 size={12} />
                          </Box>
                          <Box
                            as="button"
                            p={{ base: 3, md: 1 }}
                            color="muted"
                            _hover={{ color: "bad" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSessionToDelete(s.id);
                            }}
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </Box>
                        </Flex>
                      )}
                    </Flex>
                  );
                })}
              </Box>
            ))
          )}
        </Box>

        {/* Sidebar Footer */}
        <Box p={2.5} borderTop="1px solid var(--chakra-colors-chatLine)" fontSize="10.5px" color="muted">
          <Flex alignItems="center" gap={1.5}>
            <Terminal size={12} color="var(--chakra-colors-accent)" />
            <Text whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
              Project: {project}
            </Text>
          </Flex>
        </Box>
      </Box>

      {/* Main Chat Area */}
      <Flex flex={1} flexDirection="column" minW={0} h="100%" bg="canvas">
        {/* Top Chat Bar */}
        <Flex
          px={4}
          py={2.5}
          borderBottom="1px solid"
          borderColor="chatLine"
          bg="chatPanel"
          alignItems="center"
          justifyContent="space-between"
          gap={2}
          flexWrap="wrap"
        >
          <Flex alignItems="center" gap={2}>
            <Box
              as="button"
              display={{ base: "flex", md: "none" }}
              alignItems="center"
              justifyContent="center"
              w="40px"
              h="40px"
              ml="-8px"
              color="muted"
              aria-label="Open chat list"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu size={18} />
            </Box>

            <Flex alignItems="center" gap={2}>
              <Box
                w="8px"
                h="8px"
                borderRadius="full"
                bg={isGenerating ? "amber" : "good"}
                animation={isGenerating ? "pulse 1.5s infinite" : undefined}
              />
              <Text fontSize="13px" fontWeight={700} color="ink" fontFamily="system-ui, sans-serif">
                {activeSession?.title || "Standalone Coding Agent"}
              </Text>
              <Box
                as="span"
                fontSize="10px"
                px={1.5}
                py={0.2}
                borderRadius="3px"
                bg="surface2"
                color="accent"
                fontFamily="ui-monospace, monospace"
              >
                {project}
              </Box>
            </Flex>
          </Flex>

          {/* Model & Thinking controls */}
          <Flex alignItems="center" gap={2} flexWrap="wrap">
            {/* Model picker (reuses the searchable picker used everywhere else) */}
            <Flex alignItems="center" gap={1} minW={0}>
              <Text fontSize="11px" color="muted" flexShrink={0}>
                Model:
              </Text>
              <Box minW="180px" maxW="260px">
                <ModelPicker
                  value={selectedModel}
                  models={models}
                  onChange={pickModel}
                  compact
                  hideLevel
                  ariaLabel="chat model"
                />
              </Box>
            </Flex>

            {/* Thinking level picker */}
            <Flex alignItems="center" gap={1}>
              <Text fontSize="11px" color="muted">
                Thinking:
              </Text>
              <SelectEl
                minH={{ base: "40px", md: "0" }}
                value={thinkingLevel}
                onChange={(e) => pickThinking(e.target.value)}
                style={selectControlStyle}
              >
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </SelectEl>
            </Flex>

            {/* Total tokens pill */}
            {totalTokens.total > 0 && (
              <Box
                display={{ base: "none", lg: "block" }}
                px={2}
                py={1}
                borderRadius="md"
                bg="chatInput"
                border="1px solid var(--chakra-colors-chatLine)"
                fontSize="10.5px"
                color="muted"
                fontFamily="ui-monospace, monospace"
                title={`Tokens: ${totalTokens.input} in / ${totalTokens.output} out / ${totalTokens.cacheRead} cached`}
              >
                {(totalTokens.total / 1000).toFixed(1)}k tokens
              </Box>
            )}
          </Flex>
        </Flex>

        {/* Message Stream */}
        <Box
          flex={1}
          overflowY="auto"
          p={{ base: 3, md: 5 }}
          ref={scrollContainerRef}
          onScroll={handleScroll}
          position="relative"
        >
          {loading ? (
            <Flex justifyContent="center" alignItems="center" h="100%" color="muted" fontSize="13px">
              Loading session history...
            </Flex>
          ) : !activeSession || (activeSession.messages.length === 0 && !streamText && !streamThinking) ? (
            /* Empty state */
            <Box maxW="600px" mx="auto" my="auto" textAlign="center" pt={{ base: 6, md: 12 }}>
              <Box
                w="48px"
                h="48px"
                mx="auto"
                mb={4}
                borderRadius="12px"
                bg="rgba(122, 162, 247, 0.12)"
                display="flex"
                alignItems="center"
                justifyContent="center"
                color="accent"
              >
                <Bot size={28} />
              </Box>

              <Text fontSize="18px" fontWeight={700} color="ink" mb={1} fontFamily="system-ui, sans-serif">
                Coding Agent · {project}
              </Text>
              <Text fontSize="13px" color="muted" mb={6} lineHeight="1.5">
                Full-featured standalone coding assistant running in your project repository with read, bash, edit,
                and write tools. Complete replacement for the Pi CLI TUI.
              </Text>

              {/* Starter prompts */}
              <Flex flexDirection="column" gap={2} textAlign="left">
                {[
                  {
                    icon: <FileCode size={14} color="var(--chakra-colors-accent)" />,
                    text: "Explore this codebase and give a high-level architectural overview",
                  },
                  {
                    icon: <Terminal size={14} color="var(--chakra-colors-good)" />,
                    text: "Check git status and explain any unstaged or recent commits",
                  },
                  {
                    icon: <CheckCircle size={14} color="var(--chakra-colors-amber)" />,
                    text: "Run the project test suite using bash and report any failing tests",
                  },
                ].map((item, idx) => (
                  <Box
                    key={idx}
                    as="button"
                    p={3}
                    borderRadius="md"
                    border="1px solid var(--chakra-colors-chatLine)"
                    bg="chatCard"
                    cursor="pointer"
                    display="flex"
                    alignItems="center"
                    gap={3}
                    _hover={{ bg: "#191e2e", borderColor: "#333d54" }}
                    onClick={() => handleSendMessage(item.text)}
                  >
                    {item.icon}
                    <Text fontSize="12.5px" color="ink">
                      {item.text}
                    </Text>
                  </Box>
                ))}
              </Flex>
            </Box>
          ) : (
            /* Messages list */
            <Flex flexDirection="column" gap={4} maxW="880px" mx="auto">
              {activeSession.messages.map((msg, index) => {
                const isUser = msg.role === "user";

                return (
                  <Box
                    key={msg.id || index}
                    display="flex"
                    flexDirection="column"
                    alignItems={isUser ? "flex-end" : "flex-start"}
                    w="100%"
                  >
                    {/* Role header */}
                    <Flex alignItems="center" gap={1.5} mb={1} px={1}>
                      {isUser ? (
                        <>
                          <Text fontSize="11px" fontWeight={600} color="accent">
                            You
                          </Text>
                          <User size={13} color="var(--chakra-colors-accent)" />
                        </>
                      ) : (
                        <>
                          <Bot size={13} color="var(--chakra-colors-good)" />
                          <Text fontSize="11px" fontWeight={600} color="good">
                            Pi Agent
                          </Text>
                          {msg.model && (
                            <Box
                              as="span"
                              fontSize="10px"
                              px={1.5}
                              py={0.2}
                              borderRadius="3px"
                              bg="chatInput"
                              color="muted"
                              fontFamily="ui-monospace, monospace"
                            >
                              {msg.model}
                            </Box>
                          )}
                          <Text fontSize="10px" color="muted">
                            {formatTime(msg.timestamp)}
                          </Text>
                        </>
                      )}
                    </Flex>

                    {/* Message Card */}
                    <Box
                      maxW="100%"
                      w={isUser ? "auto" : "100%"}
                      bg={isUser ? "surface2" : "chatCard"}
                      border="1px solid"
                      borderColor="chatLine"
                      borderRadius="lg"
                      p={3.5}
                      color="ink"
                    >
                      {/* Thinking trace if assistant */}
                      {!isUser && msg.thinking && <ThinkingBlock thinking={msg.thinking} isStreaming={false} />}

                      {/* Tool calls if assistant */}
                      {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
                        <Box my={1}>
                          {msg.toolCalls.map((tc, tcIdx) => (
                            <ToolCallCard key={tc.id || tcIdx} toolCall={tc} isStreaming={false} />
                          ))}
                        </Box>
                      )}

                      {/* Content */}
                      {isUser ? (
                        <Text fontSize="13px" lineHeight="1.5" whiteSpace="pre-wrap">
                          {msg.content}
                        </Text>
                      ) : (
                        <MarkdownContent content={msg.content} />
                      )}

                      {/* Turn usage summary */}
                      {!isUser && msg.usage && (
                        <Flex mt={2} pt={1.5} borderTop="1px solid var(--chakra-colors-chatLine)" gap={2} fontSize="10px" color="muted">
                          <Text fontFamily="ui-monospace, monospace">
                            Tokens: {msg.usage.input} in · {msg.usage.output} out · {msg.usage.cacheRead} cached
                          </Text>
                        </Flex>
                      )}
                    </Box>
                  </Box>
                );
              })}

              {/* Streaming Turn (in progress) */}
              {isGenerating && (
                <Box display="flex" flexDirection="column" alignItems="flex-start" w="100%">
                  <Flex alignItems="center" gap={1.5} mb={1} px={1}>
                    <Bot size={13} color="var(--chakra-colors-good)" />
                    <Text fontSize="11px" fontWeight={600} color="good">
                      Pi Agent
                    </Text>
                    <Sparkles size={11} color="var(--chakra-colors-amber)" className="animate-spin" />
                    <Text fontSize="10.5px" color="amber" fontStyle="italic">
                      {streamStatus || "Working..."}
                    </Text>
                  </Flex>

                  <Box w="100%" bg="chatCard" border="1px solid var(--chakra-colors-chatLine)" borderRadius="lg" p={3.5} color="ink">
                    {/* Streaming Thinking */}
                    {streamThinking && <ThinkingBlock thinking={streamThinking} isStreaming={true} />}

                    {/* Streaming Tool Calls */}
                    {streamToolCalls.length > 0 && (
                      <Box my={1}>
                        {streamToolCalls.map((tc, tcIdx) => (
                          <ToolCallCard key={tc.id || tcIdx} toolCall={tc} isStreaming={!tc.result} />
                        ))}
                      </Box>
                    )}

                    {/* Streaming text */}
                    {streamText ? (
                      <MarkdownContent content={streamText} />
                    ) : (
                      !streamThinking &&
                      streamToolCalls.length === 0 && (
                        <Text fontSize="12.5px" color="muted" fontStyle="italic">
                          Thinking...
                        </Text>
                      )
                    )}
                  </Box>
                </Box>
              )}

              <div ref={messagesEndRef} />
            </Flex>
          )}

          {/* Floating Scroll to Bottom Button */}
          {showScrollBottom && (
            <Box
              as="button"
              position="sticky"
              bottom="16px"
              left="50%"
              transform="translateX(-50%)"
              px={3}
              py={1.5}
              borderRadius="full"
              bg="surface2"
              border="1px solid"
              borderColor="chatLine"
              color="ink"
              fontSize="11.5px"
              fontWeight={600}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={1.5}
              boxShadow="0 4px 12px rgba(0,0,0,0.4)"
              _hover={{ bg: "surface" }}
              onClick={() => scrollToBottom(true)}
            >
              <ArrowDown size={13} />
              Scroll to bottom
            </Box>
          )}
        </Box>

        {/* Bottom Input Area */}
        <Box p={3} bg="chatPanel" borderTop="1px solid" borderColor="chatLine">
          <Box maxW="880px" mx="auto">
            <Flex
              borderRadius="lg"
              border="1px solid"
              borderColor="chatLine"
              bg="chatInput"
              p={2}
              alignItems="flex-end"
              gap={2}
              _focusWithin={{ borderColor: "accent" }}
            >
              <textarea
                ref={textareaRef}
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isGenerating
                    ? "Agent is working... Press Stop to cancel"
                    : "Ask anything or instruct the agent to inspect, edit, or test your code... (Enter to send)"
                }
                rows={Math.min(6, Math.max(1, inputPrompt.split("\n").length))}
                disabled={isGenerating}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--chakra-colors-ink)",
                  fontSize: "13px",
                  lineHeight: "1.5",
                  fontFamily: "system-ui, sans-serif",
                  resize: "none",
                  padding: "8px",
                }}
              />

              {isGenerating ? (
                <Box
                  as="button"
                  onClick={handleAbort}
                  p={2}
                  minW="40px"
                  minH="40px"
                  borderRadius="md"
                  bg="bad"
                  color="#fff"
                  cursor="pointer"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  _hover={{ bg: "#fa7979" }}
                  title="Stop agent execution"
                >
                  <Square size={16} fill="currentColor" />
                </Box>
              ) : (
                <Box
                  as="button"
                  onClick={() => handleSendMessage()}
                  aria-disabled={!inputPrompt.trim()}
                  p={2}
                  minW="40px"
                  minH="40px"
                  borderRadius="md"
                  bg={inputPrompt.trim() ? "accent" : "surface2"}
                  color={inputPrompt.trim() ? "onAccent" : "muted"}
                  cursor={inputPrompt.trim() ? "pointer" : "not-allowed"}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  _hover={inputPrompt.trim() ? { bg: "#89b4fa" } : undefined}
                  title="Send message (Enter)"
                >
                  <Send size={16} />
                </Box>
              )}
            </Flex>

            {/* Quick footer hint */}
            <Flex justifyContent="space-between" alignItems="center" px={1} mt={1.5} fontSize="10.5px" color="muted">
              <Text>Press Enter to send, Shift+Enter for new line</Text>
              {activeSession && (
                <Text fontFamily="ui-monospace, monospace">
                  Session ID: {activeSession.id.slice(0, 8)}
                </Text>
              )}
            </Flex>
          </Box>
        </Box>
      </Flex>

      {/* Delete session confirm dialog */}
      <ConfirmDialog
        open={!!sessionToDelete}
        title="Delete Chat Session?"
        body="This will delete the session file from disk. This action cannot be undone."
        confirmLabel="Delete Session"
        onConfirm={handleDeleteSession}
        onClose={() => setSessionToDelete(null)}
      />
    </Box>
  );
}

const selectControlStyle: React.CSSProperties = {
  fontSize: "11px",
  background: "var(--chakra-colors-chatInput)",
  color: "var(--chakra-colors-ink)",
  border: "1px solid var(--chakra-colors-chatLine)",
  borderRadius: "4px",
  padding: "3px 6px",
  outline: "none",
  fontFamily: "system-ui, sans-serif",
  cursor: "pointer",
};
