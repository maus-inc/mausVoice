export const chatBubbleMaxWidth = {
  xs: "86%",
  sm: "78%",
} as const;

// Keep wrapped confirmation labels inside narrow cards without breaking short
// words character-by-character.
export const wrappableActionButtonSx = {
  minWidth: 0,
  maxWidth: "100%",
  whiteSpace: "normal",
  overflowWrap: "break-word",
  wordBreak: "normal",
  textAlign: "center",
} as const;
