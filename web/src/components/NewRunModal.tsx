import { Box, Flex, Text } from "@chakra-ui/react";
import { GhostButton } from "../ui/buttons";

export default function NewRunModal({
  open,
  onClose,
  form,
}: {
  open: boolean;
  onClose: () => void;
  form: React.ReactElement | null;
}) {
  if (!open) return null;
  return (
    <Box
      position="fixed"
      inset={0}
      zIndex={50}
      bg="rgba(0,0,0,0.6)"
      display="flex"
      alignItems="flex-start"
      justifyContent="center"
      overflowY="auto"
      p={{ base: 3, md: 8 }}
      onClick={onClose}
    >
      <Box
        bg="surface"
        border="1px solid"
        borderColor="line"
        borderRadius="lg"
        w="680px"
        maxW="100%"
        p={5}
        onClick={(e) => e.stopPropagation()}
      >
        <Flex alignItems="center" mb={3}>
          <Text fontSize="15px" fontWeight={800} fontFamily="system-ui, sans-serif">
            New Run
          </Text>
          <Box flex="1" />
          <GhostButton onClick={onClose}>
            ✕ Close (Esc)
          </GhostButton>
        </Flex>
        {form}
        <Text fontSize="10px" color="#c9cdd8" mt={3} fontFamily="system-ui, sans-serif">
          Tip: Press ⌘/Ctrl+Enter to start. Picks persist in this browser.
        </Text>
      </Box>
    </Box>
  );
}
