// Fixed-header geometry shared by App and ChatView. Below md the header is two
// rows (project/actions, then view tabs) so nothing scrolls sideways on a phone.
export const HEADER_H = { base: "96px", md: "52px" } as const;
/** Offset below the fixed header (header height + 1px border). */
export const HEADER_OFFSET = { base: "97px", md: "53px" } as const;
export const BELOW_HEADER_H = { base: "calc(100dvh - 97px)", md: "calc(100dvh - 53px)" } as const;

/** Phone: keep a form's primary action pinned to the bottom of the viewport while its long body scrolls. */
export const STICKY_ACTIONS = {
  position: { base: "sticky", md: "static" },
  bottom: { base: "0", md: "auto" },
  zIndex: 5,
  bg: "surface",
  py: { base: 2, md: 0 },
  borderTop: { base: "1px solid", md: "none" },
  borderColor: "line",
} as const;

/** Top offset for sticky banners that must sit just below the fixed header. */
export const STICKY_BELOW_HEADER = { base: "105px", md: "61px" } as const;
