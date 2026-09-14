import { Box, Flex, Text } from "@chakra-ui/react";
import { DangerOutlineButton, GhostButton } from "../ui/buttons";

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Box
      position="fixed"
      inset={0}
      zIndex={60}
      bg="rgba(0,0,0,0.65)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={4}
      onClick={onClose}
    >
      <Box
        bg="surface"
        border="1px solid"
        borderColor="line"
        borderRadius="lg"
        w="440px"
        maxW="100%"
        p={5}
        onClick={(e) => e.stopPropagation()}
      >
        <Text fontSize="14px" fontWeight={800} fontFamily="system-ui, sans-serif" mb={2}>
          {title}
        </Text>
        <Text fontSize="12px" color="#c9cdd8" fontFamily="system-ui, sans-serif" mb={4}>
          {body}
        </Text>
        <Flex gap={2} justifyContent="flex-end">
          <GhostButton onClick={onClose}>
            Keep Running
          </GhostButton>
          <DangerOutlineButton onClick={onConfirm}>
            {confirmLabel}
          </DangerOutlineButton>
        </Flex>
      </Box>
    </Box>
  );
}
