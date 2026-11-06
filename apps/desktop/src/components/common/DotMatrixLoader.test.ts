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

it("walks all sixteen ring cells clockwise without duplicate or missing phases", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(DotMatrixLoader, { mode: "ring" })));
    const dots = Array.from(
      container.querySelectorAll<HTMLElement>(".mv-dmx-dot"),
    );
    const clockwise = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5];
    expect(
      clockwise.map((index) =>
        Number(
          getComputedStyle(dots[index]).getPropertyValue("--mv-dmx-delay"),
        ),
      ),
    ).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(
      dots.filter((dot) => dot.classList.contains("mv-dmx-off")),
    ).toHaveLength(9);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("reduced motion overrides every mode without showing disabled ring cells", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("src/styles/dotmatrix.css", "utf8");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  try {
    const media = [...style.sheet!.cssRules].find(
      (rule) =>
        rule instanceof CSSMediaRule &&
        rule.conditionText.includes("prefers-reduced-motion"),
    ) as CSSMediaRule;
    expect(media).toBeDefined();
    const override = [...media.cssRules].find(
      (rule) => rule instanceof CSSStyleRule && rule.style.animation === "none",
    ) as CSSStyleRule;
    expect(override).toBeDefined();
    expect(override.selectorText).toBe(".mv-dmx .mv-dmx-dot");
    // The media rule comes after each equally specific mode rule. Its selector
    // must match every actual grid/dot pair, including the hidden ring cells.
    for (const mode of DOT_MATRIX_MODES) {
      const grid = document.createElement("div");
      grid.className = `mv-dmx mv-dmx-${mode}`;
      grid.innerHTML =
        '<span class="mv-dmx-dot"></span><span class="mv-dmx-dot mv-dmx-off"></span>';
      expect(grid.querySelectorAll(override.selectorText)).toHaveLength(2);
    }
    const off = [...media.cssRules].find(
      (rule) =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes("mv-dmx-off"),
    ) as CSSStyleRule;
    expect(off.style.opacity).toBe("0");
  } finally {
    style.remove();
  }
});
