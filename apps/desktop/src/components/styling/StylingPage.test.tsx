// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";

vi.mock("../../utils/feature.utils", () => ({
  getEffectiveStylingMode: () => "manual",
}));
vi.mock("./AppStylingLayout", () => ({ AppStylingLayout: () => null }));
vi.mock("./ManualStylingLayout", () => ({ ManualStylingLayout: () => null }));
vi.mock("./StylingDialog", () => ({ StylingDialog: () => null }));

import StylingPage from "./StylingPage";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("StylingPage layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("gives the scroll-list child a bounded page height", () => {
    act(() => {
      root.render(
        <ThemeProvider theme={theme}>
          <StylingPage />
        </ThemeProvider>,
      );
    });

    const page = container.firstElementChild;
    if (!page) throw new Error("Expected StylingPage to render its layout");
    const style = getComputedStyle(page);
    expect(style.height).toBe("100%");
    expect(style.minHeight).toBe("0px");
    expect(style.overflow).toBe("hidden");
  });
});
