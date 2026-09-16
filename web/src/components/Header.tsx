import { Box, Flex, Text } from "@chakra-ui/react";
import { SelectEl, selectStyleMini } from "../ui/controls";
import { GhostButton, PrimaryButton } from "../ui/buttons";
import type { Project } from "../api";

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
}) {
  return (
    <Flex
      as="header"
      h="52px"
      flexShrink={0}
      alignItems="center"
      gap={3}
      px={4}
      borderBottom="1px solid"
      borderColor="line"
      bg="surface"
      position="sticky"
      top={0}
      zIndex={20}
    >
      <Text fontWeight="800" fontSize="15px" letterSpacing="tight" fontFamily="system-ui, sans-serif">
        nano-cycle
      </Text>
      {liveCount > 0 && (
        <Box
          fontSize="10px"
          px={2}
          py="2px"
          borderRadius="full"
          bg="accent"
          color="#0f1115"
          fontWeight="700"
          fontFamily="system-ui, sans-serif"
        >
          ● {liveCount} live
        </Box>
      )}
      <Box w="220px" maxW="30vw">
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
        {showAdd ? "Close" : "+ Project"}
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
        − Remove
      </GhostButton>
      <Box flex="1" />
      <Flex alignItems="center" gap={2}>
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={connected ? "#4fd6a8" : "#f0b429"}
          title={connected ? "ws connected" : "ws reconnecting…"}
        />
        <Text fontSize="10px" color="muted" display={{ base: "none", md: "block" }} fontFamily="system-ui, sans-serif">
          {connected ? "Live" : "Reconnecting…"}
        </Text>
      </Flex>
      <PrimaryButton onClick={onNewRun}>
        ＋ New Run
      </PrimaryButton>
    </Flex>
  );
}
