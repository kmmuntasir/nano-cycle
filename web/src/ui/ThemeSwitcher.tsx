import { Box, Flex } from "@chakra-ui/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./theme";
import type { ThemeMode } from "./theme";

const OPTIONS: { id: ThemeMode; label: string; title: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", title: "Light mode", Icon: Sun },
  { id: "dark", label: "Dark", title: "Dark mode", Icon: Moon },
  { id: "system", label: "System", title: "Follow system appearance", Icon: Monitor },
];

/** Light / dark / system segmented switcher. Lives in the global header. */
export default function ThemeSwitcher() {
  const { mode, setMode } = useTheme();
  return (
    <Flex
      alignItems="center"
      border="1px solid"
      borderColor="line"
      borderRadius="md"
      bg="surface2"
      p="2px"
      gap="1px"
      role="group"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ id, label, title, Icon }) => {
        const active = mode === id;
        return (
          <Box
            key={id}
            as="button"
            display="flex"
            alignItems="center"
            gap={1}
            px={2}
            py={1}
            borderRadius="sm"
            fontSize="11px"
            fontFamily="system-ui, sans-serif"
            fontWeight={active ? 700 : 500}
            bg={active ? "surface" : "transparent"}
            color={active ? "accent" : "muted"}
            border="1px solid"
            borderColor={active ? "line" : "transparent"}
            cursor="pointer"
            title={title}
            aria-label={title}
            aria-pressed={active}
            onClick={() => setMode(id)}
            _hover={{ color: active ? "accent" : "ink" }}
          >
            <Icon size={13} />
            <Box as="span" display={{ base: "none", md: "inline" }}>
              {label}
            </Box>
          </Box>
        );
      })}
    </Flex>
  );
}
