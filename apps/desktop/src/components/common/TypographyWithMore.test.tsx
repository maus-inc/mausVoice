// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { TypographyWithMore } from "./TypographyWithMore";

ensureUiHarness();

/** All style text emotion has injected into the document. */
const styleText = () =>
  Array.from(document.querySelectorAll("style"))
    .map((node) => node.textContent ?? "")
    .join("\n");

/** CSS blocks whose selector carries one of the element's classes at :hover. */
const hoverRulesFor = (el: Element): string => {
  const text = styleText();
  const rules: string[] = [];
  for (const cls of el.classList) {
    for (const match of text.matchAll(
      new RegExp(`\\.${cls}[^{}]*:hover\\{[^}]*\\}`, "g"),
    )) {
      rules.push(match[0]);
    }
  }
  return rules.join("\n");
};

let root: Root | undefined;
let container: HTMLDivElement;
let scrollHeightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  // jsdom has no layout: force the measure pass to see overflow by granting
  // every element a scrollHeight taller than the clamp, and getComputedStyle
  // a finite lineHeight. Both are restored in afterEach.
  scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    value: 320,
  });

  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (el: Element, pseudo?: string | null) => {
      const styles = real(el, pseudo);
      return new Proxy(styles, {
        get: (target, prop) =>
          prop === "lineHeight"
            ? "20px"
            : (target as unknown as Record<PropertyKey, unknown>)[
                prop as PropertyKey
              ],
      });
    },
  );

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  if (scrollHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      scrollHeightDescriptor,
    );
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});

const render = async () => {
  await act(async () => {
    root?.render(
      <StrictMode>
        <ThemeProvider theme={theme}>
          <TypographyWithMore variant="body2" maxLines={3}>
            A long transcription that keeps going well past three lines so the
            clamp engages and the disclosure control appears.
          </TypographyWithMore>
        </ThemeProvider>
      </StrictMode>,
    );
  });
};

const toggleButton = () => {
  const buttons = Array.from(container.querySelectorAll("button"));
  return buttons.find((b) =>
    ["Show more", "Show less"].includes(b.textContent ?? ""),
  );
};

describe("TypographyWithMore disclosure toggle", () => {
  it("renders collapsed with an inline 'Show more' whose hover is a link affordance, not a repaint of the fade", async () => {
    await render();
    const button = toggleButton();
    expect(button).not.toBeUndefined();
    expect(button?.textContent).toBe("Show more");

    const hover = hoverRulesFor(button!);
    // The theme's stock text-button hover (level2) still exists in the
    // cascade; the rule that WINS (last in emitted order) must keep the
    // truncation-fade tier. A repaint double-toned the mask — pinned here.
    const bgs = [...hover.matchAll(/background-color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(bgs[bgs.length - 1]).toContain("var(--app-palette-level0");
    // Affordance comes from a color deepen plus an underline fade-in, not a
    // background repaint (the link treatment for in-flow text toggles).
    const colors = [...hover.matchAll(/[;{]color:([^;}]+)/g)].map((m) => m[1]);
    expect(colors[colors.length - 1]).toContain(
      "var(--app-palette-text-primary",
    );
    expect(hover).toContain("text-decoration-color:currentColor");
  });

  it("expands to a block 'Show less' whose hover is the surface ladder's quiet tier", async () => {
    await render();
    await act(async () => {
      toggleButton()?.click();
    });

    const button = toggleButton();
    expect(button).not.toBeUndefined();
    expect(button?.textContent).toBe("Show less");

    const hover = hoverRulesFor(button!);
    const bgs = [...hover.matchAll(/background-color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(bgs[bgs.length - 1]).toContain("var(--app-palette-level2");
    expect(hover).not.toContain("text-decoration-color:currentColor");
  });
});
