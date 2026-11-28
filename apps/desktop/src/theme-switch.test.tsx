// @vitest-environment jsdom
import { Switch, ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ensureUiHarness } from "../test/helpers/jsdom-ui-harness";
import { theme } from "./theme";

ensureUiHarness();

describe("switch theme", () => {
  it("gives the checked thumb a contrasting color to its track", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          createElement(
            ThemeProvider,
            { theme },
            createElement(Switch, { checked: true, onChange: () => {} }),
          ),
        ),
      );
      const base = container.querySelector<HTMLElement>(
        ".MuiSwitch-switchBase",
      );
      const track = container.querySelector<HTMLElement>(".MuiSwitch-track");
      if (!base || !track) throw new Error("Switch was not rendered");
      expect(getComputedStyle(base).color).toBe("rgb(255, 255, 255)");
      expect(getComputedStyle(track).backgroundColor).toBe("rgb(26, 23, 18)");
      document.documentElement.dataset.muiColorScheme = "dark";
      expect(getComputedStyle(base).color).toBe("rgb(26, 23, 18)");
      expect(getComputedStyle(track).backgroundColor).toBe(
        "rgb(255, 255, 255)",
      );
    } finally {
      delete document.documentElement.dataset.muiColorScheme;
      act(() => root.unmount());
      container.remove();
    }
  });
});
