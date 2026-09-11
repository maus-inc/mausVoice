// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { DOT_MATRIX_MODES, DotMatrixLoader } from "./DotMatrixLoader";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DotMatrixLoader", () => {
  it("renders a 5x5 grid and picks a stable mode from the seed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(DotMatrixLoader, {
          seed: "tool-abc",
          size: 14,
          dotSize: 2,
        }),
      );
    });
    const grid = container.querySelector(".mv-dmx");
    expect(grid).not.toBeNull();
    expect(container.querySelectorAll(".mv-dmx-dot")).toHaveLength(25);
    const modeClass = [...(grid?.classList ?? [])].find(
      (name) => name.startsWith("mv-dmx-") && name !== "mv-dmx",
    );
    expect(
      modeClass &&
        DOT_MATRIX_MODES.some((mode) => `mv-dmx-${mode}` === modeClass),
    ).toBe(true);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
