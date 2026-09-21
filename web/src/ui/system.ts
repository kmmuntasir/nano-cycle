import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

// "Workbench" theme with light / dark / system support.
//
// The palette lives in `semanticTokens` so every token below resolves to a
// light value by default and flips to its `_dark` value whenever a `.dark`
// class is present on <html> (see ui/theme.tsx, which owns that class).
// Components must reference these tokens (bg="surface", color="ink", …)
// instead of hardcoded hexes for the switcher to have any effect.
export const system = createSystem(
  defaultConfig,
  defineConfig({
    globalCss: {
      html: {
        bg: "var(--chakra-colors-canvas)",
        color: "var(--chakra-colors-ink)",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
      body: {
        bg: "var(--chakra-colors-canvas)",
        color: "var(--chakra-colors-ink)",
      },
    },
    theme: {
      keyframes: {
        ncPulse: {
          "0%,100%": { opacity: 1 },
          "50%": { opacity: 0.35 },
        },
        ncSpin: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
      },
      semanticTokens: {
        colors: {
          canvas: { value: { base: "#e9edf3", _dark: "#0f1115" } },
          surface: { value: { base: "#ffffff", _dark: "#151821" } },
          surface2: { value: { base: "#ecf0f6", _dark: "#1b1f2b" } },
          line: { value: { base: "#d8dde7", _dark: "#262b38" } },
          ink: { value: { base: "#1b1e27", _dark: "#e4e4e7" } },
          muted: { value: { base: "#5c6474", _dark: "#9aa1b5" } },
          accent: { value: { base: "#2f6feb", _dark: "#7aa2f7" } },
          good: { value: { base: "#177a52", _dark: "#4fd6a8" } },
          warn: { value: { base: "#8a5d00", _dark: "#f0b429" } },
          /** Soft amber (was hardcoded #e0af68) — readable on both modes. */
          amber: { value: { base: "#8a5d00", _dark: "#e0af68" } },
          bad: { value: { base: "#c93a3a", _dark: "#f16a6a" } },
          /** Text on top of a solid accent fill. */
          onAccent: { value: { base: "#ffffff", _dark: "#0c0e14" } },
          // Chat-specific surfaces (dark values preserve the original palette).
          chatPanel: { value: { base: "#ffffff", _dark: "#10131d" } },
          chatCard: { value: { base: "#ffffff", _dark: "#121520" } },
          chatInset: { value: { base: "#eff2f7", _dark: "#0e1017" } },
          chatHeader: { value: { base: "#eef1f6", _dark: "#131620" } },
          chatInput: { value: { base: "#eef1f6", _dark: "#161a26" } },
          chatCode: { value: { base: "#f5f7fb", _dark: "#07080d" } },
          chatLine: { value: { base: "#d8dde7", _dark: "#232838" } },
        },
      },
    },
  }),
);
