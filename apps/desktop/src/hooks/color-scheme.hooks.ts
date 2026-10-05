import { useColorScheme } from "@mui/material";

/** The attribute `index.html` writes before this bundle loads. */
const BOOTSTRAPPED_SCHEME = "muiColorScheme";

/**
 * The scheme `index.html` already painted, read back off the document element.
 *
 * That inline script runs before React exists and resolves the stored mode the
 * same way this app's theme does, including its legacy key migration. Reading
 * it back is the only way to agree with what the user is currently looking at:
 * MUI reports `mode` as `undefined` on the first paint, so any fallback here
 * that re-derives the answer from `localStorage` or the media query can land on
 * a different scheme from the one on screen.
 */
const bootstrappedScheme = (): "light" | "dark" | undefined => {
  if (typeof document === "undefined") {
    return undefined;
  }

  const resolved = document.documentElement.dataset[BOOTSTRAPPED_SCHEME];

  return resolved === "dark" || resolved === "light" ? resolved : undefined;
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
  return (systemMode ?? bootstrappedScheme()) === "dark";
};
