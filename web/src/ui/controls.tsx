import { chakra } from "@chakra-ui/react";

// Native form elements styled through the Chakra factory — predictable,
// dependency-free, and consistent across the dashboard.
export const SelectEl = chakra("select");

export const selectStyleMini = {
  fontSize: "12px",
  bg: "surface2",
  color: "ink",
  border: "1px solid",
  borderColor: "line",
  borderRadius: "6px",
  px: "2",
  py: "1",
} as const;

export const selectStyle = {
  width: "100%",
  fontSize: "12px",
  bg: "surface2",
  color: "ink",
  border: "1px solid",
  borderColor: "line",
  borderRadius: "6px",
  px: "2",
  py: "1",
  outline: "none",
} as const;

export const panelBg = "surface";
export const lineColor = "line";
