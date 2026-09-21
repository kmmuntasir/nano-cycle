import { Button } from "@chakra-ui/react";
import type { ReactNode } from "react";

// Theme-safe buttons. Chakra's default colorPalette variants assume light
// mode (dark text on transparent), which turns invisible on our dark surfaces.
// These wrappers pin semantic tokens that resolve per color mode.

const SANS = "system-ui, sans-serif";

export function PrimaryButton({
  children,
  ...rest
}: {
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      bg="accent"
      color="onAccent"
      border="1px solid transparent"
      title={rest.title}
      fontFamily={SANS}
      _hover={{ bg: "#3b7bff", color: "#fff" }}
      _disabled={{ bg: "surface2", color: "muted", cursor: "not-allowed", opacity: 1 }}
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
      bg={active ? "surface2" : "transparent"}
      color={active ? "accent" : "ink"}
      borderColor={active ? "accent" : "line"}
      fontFamily={SANS}
      _hover={{ bg: "surface2", color: "ink" }}
      _disabled={{ color: "muted", borderColor: "line", opacity: 1, cursor: "not-allowed" }}
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
      color="bad"
      borderColor="line"
      fontFamily={SANS}
      _hover={{ bg: "rgba(241,106,106,0.12)", color: "bad" }}
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
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Button
      size={rest.size ?? "xs"}
      variant="ghost"
      color="muted"
      fontFamily={SANS}
      _hover={{ color: "ink", bg: "surface2" }}
      _disabled={{ color: "muted", cursor: "not-allowed", opacity: 0.6, _hover: { bg: "transparent" } }}
      disabled={rest.disabled}
      title={rest.title}
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
  disabled?: boolean;
}) {
  return (
    <Button
      size={rest.size ?? "sm"}
      bg="#f0b429"
      color="#1a1503"
      fontFamily={SANS}
      fontWeight={700}
      _hover={{ bg: "#ffc93c" }}
      _disabled={{ bg: "#5c4a12", color: "#8a7a3a", cursor: "not-allowed", opacity: 1, _hover: { bg: "#5c4a12" } }}
      disabled={rest.disabled}
      onClick={rest.onClick}
    >
      {children}
    </Button>
  );
}
