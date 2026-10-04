import { useColorScheme } from "@mui/material";

/**
 * The OS preference, read the same way MUI reads it.
 *
 * MUI leaves `systemMode` undefined on the first paint, before the stored mode
 * has been read, and this app defaults to `defaultMode: "system"`. One-shot on
 * purpose: the fallback only covers that first paint, and a subscription here
 * would re-render the whole chrome for a value MUI is already tracking once
 * `systemMode` exists.
 */
const prefersDarkScheme = (): "light" | "dark" => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

/**
 * The scheme the user is actually looking at, as a boolean.
 *
 * `useColorScheme().mode` reports the *preference*, and that is `"system"`
 * whenever the user has not picked one, which is this app's default. A component
 * that reads `mode` straight off the hook therefore paints itself light on a
 * machine that only ever runs dark, and the surfaces built from `palette.ts` end
 * up one scheme away from the text drawn on them.
 */
export const useIsDarkMode = (): boolean => {
  const { mode, systemMode } = useColorScheme();

  if (mode === "dark") {
    return true;
  }

  if (mode === "light") {
    return false;
  }

  // `"system"`, or `undefined` before the stored mode has been read.
  return (systemMode ?? prefersDarkScheme()) === "dark";
};
