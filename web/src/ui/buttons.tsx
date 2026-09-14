import { Button } from "@chakra-ui/react";
import type { ReactNode } from "react";

// Dark-mode-safe buttons. Chakra's default colorPalette variants assume light
// mode (dark text on transparent), which turns invisible on our dark surfaces.
// These wrappers pin explicit foreground/background colors.

const SANS = "system-ui, sans-serif";

export function PrimaryButton({
  children,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      bg="#2f6fed"
      color="white"
      border="1px solid transparent"
      fontFamily={SANS}
      _hover={{ bg: "#3b7bff" }}
      _disabled={{ bg: "#24407e", color: "rgba(255,255,255,0.55)", cursor: "not-allowed", opacity: 1 }}
      disabled={rest.disabled}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}

export function OutlineButton({
  children,
  active,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      variant="outline"
      bg={active ? "#1b2130" : "transparent"}
      color={active ? "#7aa2f7" : "#e4e4e7"}
      borderColor={active ? "#7aa2f7" : "#3a4152"}
      fontFamily={SANS}
      _hover={{ bg: "#1b1f2b", color: "#fff" }}
      _disabled={{ color: "#6b7280", borderColor: "#2a2f3a", opacity: 1, cursor: "not-allowed" }}
      disabled={rest.disabled}
      title={rest.title}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}

export function DangerOutlineButton({
  children,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      variant="outline"
      bg="transparent"
      color="#f16a6a"
      borderColor="#5a2d33"
      fontFamily={SANS}
      _hover={{ bg: "rgba(241,106,106,0.12)", color: "#ff8080" }}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}

export function GhostButton({
  children,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "xs"}
      variant="ghost"
      color="#a1a7b8"
      fontFamily={SANS}
      _hover={{ color: "#ffffff", bg: "#1b1f2b" }}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}

export function WarningButton({
  children,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      bg="#f0b429"
      color="#1a1503"
      fontFamily={SANS}
      fontWeight={700}
      _hover={{ bg: "#ffc93c" }}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}
