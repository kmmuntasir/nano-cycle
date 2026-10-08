import { Box, Flex, Text } from "@chakra-ui/react";
import { List, MessageCircle, Minus, Play, Plus } from "lucide-react";
import { SelectEl, selectStyleMini } from "../ui/controls";
import { GhostButton, PrimaryButton } from "../ui/buttons";
import ThemeSwitcher from "../ui/ThemeSwitcher";
import { HEADER_H } from "../ui/layout";
import type { SocketStatus } from "../lib/socket";
import type { Project } from "../api";

export type View = "runs" | "tickets" | "chat";

const TABS: { id: View; label: string; short: string; Icon: typeof Play }[] = [
  { id: "runs", label: "Runs", short: "Runs", Icon: Play },
  { id: "tickets", label: "Tickets & Queue", short: "Tickets", Icon: List },
  { id: "chat", label: "Chat", short: "Chat", Icon: MessageCircle },
];

function Divider() {
  return <Box display={{ base: "none", md: "block" }} w="1px" alignSelf="stretch" my={2} bg="line" flexShrink={0} />;
}

export default function Header({
  projects,
  project,
  setProject,
  onToggleAdd,
  onRemoveProject,
  showAdd,
  onNewRun,
  wsStatus,
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
  wsStatus: SocketStatus;
  liveCount: number;
  view: View;
  setView: (v: View) => void;
}) {
  const connected = wsStatus === "open";
  // Below md the header is two rows (project + actions, then the view tabs);
  // `alignContent="stretch"` splits the fixed height evenly between the lines.
  // From md up it is the original single row.
  return (
    <Flex
      as="header"
      h={HEADER_H}
      alignItems="center"
      alignContent="stretch"
      flexWrap={{ base: "wrap", md: "nowrap" }}
      columnGap={2}
      rowGap={0}
      px={3}
      borderBottom="1px solid"
      borderColor="line"
      bg="surface"
      position="fixed"
      top={0}
      left={0}
      right={0}
      zIndex={40}
      overflowX={{ base: "hidden", md: "auto" }}
      overflowY="hidden"
      whiteSpace="nowrap"
    >
      {/* brand — desktop only; the phone header spends that space on the project picker */}
      <Text
        display={{ base: "none", md: "block" }}
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
          display={{ base: "none", md: "inline-flex" }}
          fontSize="10px"
          px={2}
          py="2px"
          borderRadius="full"
          bg="accent"
          color="onAccent"
          fontWeight="700"
          fontFamily="system-ui, sans-serif"
          alignItems="center"
          gap={1.5}
          flexShrink={0}
        >
          <Box w="6px" h="6px" borderRadius="full" bg="currentColor" />
          {liveCount} live
        </Box>
      )}

      <Divider />

      {/* view tabs — full-width second row on phones */}
      <Flex
        order={{ base: 10, md: 0 }}
        flexBasis={{ base: "100%", md: "auto" }}
        alignItems="stretch"
        alignSelf="stretch"
        flexShrink={0}
        gap={1}
      >
        {TABS.map(({ id, label, short, Icon }) => {
          const active = view === id;
          return (
            <Box
              key={id}
              as="button"
              flex={{ base: 1, md: "none" }}
              minH="40px"
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
              aria-current={active ? "page" : undefined}
            >
              <Box as="span" display="inline-flex" alignItems="center" justifyContent="center" gap={1.5}>
                <Icon size={14} />
                <Box as="span" display={{ base: "none", sm: "inline" }}>
                  {label}
                </Box>
                <Box as="span" display={{ base: "inline", sm: "none" }}>
                  {short}
                </Box>
                {id === "runs" && liveCount > 0 && (
                  <Box
                    as="span"
                    display={{ base: "inline-flex", md: "none" }}
                    fontSize="10px"
                    px={1.5}
                    borderRadius="full"
                    bg="accent"
                    color="onAccent"
                    fontWeight={700}
                    title={`${liveCount} live`}
                  >
                    {liveCount}
                  </Box>
                )}
              </Box>
            </Box>
          );
        })}
      </Flex>

      <Divider />

      {/* project */}
      <Box w={{ base: "auto", md: "200px" }} flex={{ base: 1, md: "none" }} minW={0} flexShrink={0}>
        <SelectEl
          minH={{ base: "40px", md: "0" }}
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
      <GhostButton onClick={onToggleAdd} title={showAdd ? "Close" : "Add project"}>
        <Box as="span" display="inline-flex" alignItems="center" gap={1}>
          <Plus size={12} />
          <Box as="span" display={{ base: "none", lg: "inline" }}>
            {showAdd ? "Close" : "Project"}
          </Box>
        </Box>
      </GhostButton>
      <GhostButton
        onClick={onRemoveProject}
        title={
          project === "sandbox"
            ? "Remove the sandbox — its scratch folder is deleted. Re-add it anytime with the repo's /sandbox path."
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

      <Box flex="1" minW={2} display={{ base: "none", md: "block" }} />
      <Box flexShrink={0}>
        <ThemeSwitcher />
      </Box>
      <Flex alignItems="center" gap={2} flexShrink={0}>
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={connected ? "good" : "warn"}
          animation={connected ? undefined : "ncPulse 1.2s ease-in-out infinite"}
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
