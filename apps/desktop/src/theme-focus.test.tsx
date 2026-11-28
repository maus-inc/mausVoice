// @vitest-environment jsdom
import { Button, IconButton, ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ensureUiHarness } from "../test/helpers/jsdom-ui-harness";
import { theme } from "./theme";

ensureUiHarness();

describe("button keyboard focus", () => {
  it.each([Button, IconButton])(
    "provides an outline on focus-visible",
    (Component) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            createElement(
              ThemeProvider,
              { theme },
              createElement(
                Component,
                { className: "Mui-focusVisible" },
                "Action",
              ),
            ),
          ),
        );
        const button = container.querySelector("button");
        expect(button).not.toBeNull();
        expect(getComputedStyle(button!).outline).toContain("2px solid");
        expect(getComputedStyle(button!).outlineOffset).toBe("2px");
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
