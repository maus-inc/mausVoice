import { ThemeProvider } from "@mui/material/styles";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { THEME_PROVIDER_CONFIG, theme } from "../../src/theme";

/**
 * Mounts a tree into its own detached host under `document.body` with the real
 * theme, and returns the handles a test needs to assert on it and to take it
 * down again.
 *
 * Emotion resolves `sx` through the theme only when a `ThemeProvider` is
 * present, so a test that reads `getComputedStyle` on a styled node mounts
 * through this helper rather than a bare `createRoot`.
 */
export const mountWithTheme = (
  children: ReactNode,
): { container: HTMLDivElement; root: Root; unmount: () => void } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        {children}
      </ThemeProvider>,
    ),
  );
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};
