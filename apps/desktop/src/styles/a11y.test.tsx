// @vitest-environment jsdom
import { Box } from "@mui/material";
import { afterEach, describe, expect, it } from "vitest";
import { requireElement } from "../../test/helpers/dom";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";
import { mountWithTheme } from "../../test/helpers/render";
import { visuallyHidden } from "./a11y";

ensureUiHarness();

let mounted: ReturnType<typeof mountWithTheme> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("visually hidden box", () => {
  it("is clipped to a pixel and pinned so it cannot extend a scroll area", () => {
    mounted = mountWithTheme(
      <Box component="span" role="status" sx={visuallyHidden}>
        Tip: dictation is ready
      </Box>,
    );
    const region = requireElement(
      mounted.container.querySelector('[role="status"]'),
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
  });
});
