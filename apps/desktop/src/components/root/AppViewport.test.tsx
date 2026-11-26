// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { afterEach, describe, expect, it } from "vitest";
import { requireElement } from "../../../test/helpers/dom";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { AppViewport } from "./AppViewport";

ensureUiHarness();

let host: HTMLDivElement | null = null;

const renderViewport = () => {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        <AppViewport>
          <main data-route="" />
        </AppViewport>
      </ThemeProvider>,
    ),
  );
  return { root, host };
};

afterEach(() => {
  host?.remove();
  host = null;
});

describe("app viewport", () => {
  it("takes the height the 100% chain already gives it", () => {
    const { root, host: container } = renderViewport();
    try {
      const viewport = requireElement(
        container.firstElementChild,
        "the viewport",
      );
      // jsdom has no layout, so the computed declaration is the contract:
      // viewport units would be sized as if scrollbars do not exist and would
      // overflow the window once one appears.
      const style = getComputedStyle(viewport);
      expect(style.height).toBe("100%");
      expect(style.width).toBe("100%");
      expect(style.overflow).toBe("hidden");
      expect(container.querySelector("[data-route]")?.parentElement).toBe(
        viewport,
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
