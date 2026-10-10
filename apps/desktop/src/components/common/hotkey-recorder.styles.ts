import { keyframes, type SxProps, type Theme } from "@mui/material/styles";

const pulseBorder = keyframes`
  0%, 100% {
    border-color: color-mix(in srgb, var(--app-palette-chrome) 50%, transparent);
  }
  50% {
    border-color: var(--app-palette-chrome);
  }
`;

export const hotkeyRecorderStyles = (
  focused: boolean,
  width = 200,
): SxProps<Theme> => ({
  width,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 1,
  cursor: "pointer",
  bgcolor: (theme) =>
    focused ? theme.vars?.palette.level2 : theme.vars?.palette.level1,
  border: focused ? "2px solid" : "2px solid transparent",
  animation: focused ? `${pulseBorder} 2s ease-in-out infinite` : "none",
  outline: "none",
  "&:hover": {
    border: (theme) =>
      focused ? "2px solid" : `2px solid ${theme.vars?.palette.divider}`,
  },
  "@media (prefers-reduced-motion: reduce)": {
    animation: "none",
    borderColor: focused ? "var(--app-palette-chrome)" : undefined,
  },
});
