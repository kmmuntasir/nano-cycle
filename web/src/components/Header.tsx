import { Box, Flex, Text } from "@chakra-ui/react";
import { List, MessageCircle, Minus, Play, Plus } from "lucide-react";
import { SelectEl, selectStyleMini } from "../ui/controls";
import { GhostButton, PrimaryButton } from "../ui/buttons";
import ThemeSwitcher from "../ui/ThemeSwitcher";
import type { Project } from "../api";

export type View = "runs" | "tickets" | "chat";

const TABS: { id: View; label: string; short: string; Icon: typeof Play }[] = [
  { id: "runs", label: "Runs", short: "Runs", Icon: Play },
  { id: "tickets", label: "Tickets & Queue", short: "Tickets", Icon: List },
  { id: "chat", label: "Chat", short: "Chat", Icon: MessageCircle },
];

function Divider() {
  return <Box w="1px" alignSelf="stretch" my={2} bg="line" flexShrink={0} />;
}

export default function Header({
  projects,
  project,
  setProject,
  onToggleAdd,
  onRemoveProject,
  showAdd,
  onNewRun,
  connected,
  liveCount,
  view,
  setView,
}: {
  projects: Project[];
  project: string;
  setProject: (v: string) => void;
  onToggleAdd: () => void;
  onRemoveProject: () => void;
  showAdd: boolean;
  onNewRun: () => void;
  connected: boolean;
  liveCount: number;
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <Flex
      as="header"
      h="52px"
      alignItems="center"
      gap={2}
      px={3}
      borderBottom="1px solid"
      borderColor="line"
      bg="surface"
      position="fixed"
      top={0}
      left={0}
      right={0}
      zIndex={40}
      overflowX="auto"
      overflowY="hidden"
      whiteSpace="nowrap"
    >
      {/* brand */}
      <Text
        fontWeight="800"
        fontSize="15px"
        letterSpacing="tight"
        fontFamily="system-ui, sans-serif"
        flexShrink={0}
      >
        nano-cycle
      </Text>
      {liveCount > 0 && (
        <Box
          fontSize="10px"
          px={2}
          py="2px"
          borderRadius="full"
          bg="accent"
          color="onAccent"
          fontWeight="700"
          fontFamily="system-ui, sans-serif"
          display="inline-flex"
          alignItems="center"
          gap={1.5}
          flexShrink={0}
        >
          <Box w="6px" h="6px" borderRadius="full" bg="currentColor" />
          {liveCount} live
        </Box>
      )}

      <Divider />

      {/* view tabs */}
      <Flex alignItems="stretch" alignSelf="stretch" flexShrink={0} gap={1}>
        {TABS.map(({ id, label, short, Icon }) => {
          const active = view === id;
          return (
            <Box
              key={id}
              as="button"
              px={2.5}
              fontSize="12px"
              fontWeight={active ? 700 : 500}
              fontFamily="system-ui, sans-serif"
              color={active ? "accent" : "muted"}
              borderBottom="2px solid"
              borderBottomColor={active ? "accent" : "transparent"}
              onClick={() => setView(id)}
              _hover={{ color: active ? "accent" : "ink" }}
              title={label}
            >
              <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
                <Icon size={13} />
                <Box as="span" display={{ base: "none", sm: "inline" }}>
                  {label}
                </Box>
                <Box as="span" display={{ base: "inline", sm: "none" }}>
                  {short}
                </Box>
              </Box>
            </Box>
          );
        })}
      </Flex>

      <Divider />

      {/* project */}
      <Box w={{ base: "130px", md: "200px" }} flexShrink={0}>
        <SelectEl
          css={{ ...selectStyleMini, width: "100%" }}
          value={project}
          onChange={(e) => setProject((e.target as HTMLSelectElement).value)}
          aria-label="project"
        >
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </SelectEl>
      </Box>
      <GhostButton onClick={onToggleAdd}>
        <Box as="span" display="inline-flex" alignItems="center" gap={1}>
          <Plus size={12} />
          <Box as="span" display={{ base: "none", lg: "inline" }}>
            {showAdd ? "Close" : "Project"}
          </Box>
        </Box>
      </GhostButton>
      <GhostButton
        disabled={project === "sandbox"}
        onClick={onRemoveProject}
        title={
          project === "sandbox"
            ? "The built-in sandbox cannot be removed."
            : `Remove "${project}" from nano-cycle — registry-only: nothing on disk is deleted, and run history is kept.`
        }
      >
        <Box as="span" display="inline-flex" alignItems="center" gap={1}>
          <Minus size={12} />
          <Box as="span" display={{ base: "none", lg: "inline" }}>
            Remove
          </Box>
        </Box>
      </GhostButton>

      <Box flex="1" minW={2} />
      <Box flexShrink={0}>
        <ThemeSwitcher />
      </Box>
      <Flex alignItems="center" gap={2} flexShrink={0}>
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={connected ? "good" : "warn"}
          title={connected ? "ws connected" : "ws reconnecting…"}
        />
        <Text fontSize="10px" color="muted" display={{ base: "none", md: "block" }} fontFamily="system-ui, sans-serif">
          {connected ? "Live" : "Reconnecting…"}
        </Text>
      </Flex>
      <PrimaryButton onClick={onNewRun}>
        <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
          <Plus size={13} />
          <Box as="span" display={{ base: "none", sm: "inline" }}>
            New Run
          </Box>
        </Box>
      </PrimaryButton>
    </Flex>
  );
}
