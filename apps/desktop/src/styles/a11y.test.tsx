// @vitest-environment jsdom
import { Box } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { requireElement } from "../../test/helpers/dom";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../theme";
import { visuallyHidden } from "./a11y";

ensureUiHarness();

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

describe("visually hidden box", () => {
  it("is clipped to a pixel and pinned so it cannot extend a scroll area", () => {
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
          <Box component="span" role="status" sx={visuallyHidden}>
            Tip: dictation is ready
          </Box>
        </ThemeProvider>,
      ),
    );
    try {
      const region = requireElement(
        host.querySelector('[role="status"]'),
        "the live region",
      );
      // jsdom cannot measure overflow. An unpinned absolutely positioned box
      // keeps its static position, which lands one pixel past the viewport at
      // the end of a portal and makes the whole document scrollable, so the
      // offsets are what the style must state.
      const style = getComputedStyle(region);
      expect(style.position).toBe("absolute");
      expect(style.top).toBe("0px");
      expect(style.left).toBe("0px");
      expect(style.width).toBe("1px");
      expect(style.height).toBe("1px");
      expect(style.overflow).toBe("hidden");
      expect(style.clipPath).toBe("inset(50%)");
    } finally {
      act(() => root.unmount());
    }
  });
});
