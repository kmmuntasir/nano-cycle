import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

// Dark "workbench" theme — the dashboard reads like an IDE: dark surfaces,
// one accent, muted secondary text. Kept explicit (no color-mode machinery).
export const system = createSystem(
  defaultConfig,
  defineConfig({
    globalCss: {
      html: {
        bg: "#0f1115",
        color: "#e4e4e7",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
      body: {
        bg: "#0f1115",
        color: "#e4e4e7",
      },
    },
    theme: {
      keyframes: {
        ncPulse: {
          "0%,100%": { opacity: 1 },
          "50%": { opacity: 0.35 },
        },
      },
      tokens: {
        colors: {
          surface: { value: "#151821" },
          surface2: { value: "#1b1f2b" },
          line: { value: "#262b38" },
          ink: { value: "#e4e4e7" },
          muted: { value: "#9aa1b5" },
          accent: { value: "#7aa2f7" },
          good: { value: "#4fd6a8" },
          warn: { value: "#f0b429" },
          bad: { value: "#f16a6a" },
        },
      },
    },
  }),
);
