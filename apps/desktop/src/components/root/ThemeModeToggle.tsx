import { IconButton, useColorScheme } from "@mui/material";
import { Moon, Sun } from "lucide";
import { useCallback, useMemo } from "react";
import { MorphIcon } from "morphicons/react";

/**
 * Light/dark mode toggle rendered in the title bar. Uses MUI's color-scheme
 * API (the theme defines both palettes). Cycling order: light -> dark ->
 * system -> light, so users can escape back to following the OS. The sun/moon
 * glyph morphs between states via morphicons.
 */
export const ThemeModeToggle = () => {
  const { mode, systemMode, setMode } = useColorScheme();

  const effectiveMode = mode === "system" ? systemMode : mode;
  const isDark = effectiveMode === "dark";

  const icon = useMemo(() => (isDark ? Moon : Sun), [isDark]);

  const cycle = useCallback(() => {
    if (mode === "light") {
      setMode("dark");
    } else if (mode === "dark") {
      setMode("system");
    } else {
      setMode("light");
    }
  }, [mode, setMode]);

  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <IconButton
      onClick={cycle}
      aria-label={label}
      size="small"
      title={label}
      sx={{
        width: 28,
        height: 28,
        borderRadius: 1.5,
        color: "text.secondary",
        "&:hover": { backgroundColor: "action.hover" },
      }}
    >
      <MorphIcon icon={icon} size={18} strokeWidth={1.9} spring="snappy" />
    </IconButton>
  );
};
