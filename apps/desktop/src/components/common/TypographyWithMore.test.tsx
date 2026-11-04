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

/**
 * The element's own CSS for a selector state. `state` is a fragment of the
 * selector, so ":focus-visible" matches a pseudo-class selector. A media
 * condition is different: emotion emits it around the rule, so
 * "@media (hover: none)" is matched as a prefix instead.
 */
const stateRulesFor = (el: Element, state: string): string => {
  const text = styleText();
  const rules: string[] = [];
  for (const cls of el.classList) {
    const pattern = state.startsWith("@media")
      ? // Emotion emits a media condition around the rule it guards:
        // @media (hover: none){.cls{...}}, so the condition precedes the class.
        // \s* absorbs the space emotion puts after the colon.
        `${state.replace(/[()]/g, (c) => `\\${c}`).replace(/\\:\\s*/, ":\\\\s*")}\\{\\.${cls}\\{[^}]*\\}`
      : // A pseudo-class hangs off the class's own selector.
        `\\.${cls}[^{}]*${state}[^{}]*\\{[^}]*\\}`;
    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
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

const render = async (
  clampPaddingRight?: number | string,
  inlineToggleRight?: number | string,
) => {
  await act(async () => {
    root?.render(
      <StrictMode>
        <ThemeProvider theme={theme}>
          <TypographyWithMore
            variant="body2"
            maxLines={3}
            clampPaddingRight={clampPaddingRight}
            inlineToggleRight={inlineToggleRight}
          >
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

/**
 * The disclosure toggle, throwing instead of returning `undefined` so the
 * caller does not have to assert the element away with a non-null assertion.
 */
const requireToggleButton = (): HTMLButtonElement => {
  const found = toggleButton();
  if (!found) {
    throw new Error(
      "TypographyWithMore rendered no Show more/Show less toggle",
    );
  }
  return found;
};

describe("TypographyWithMore disclosure toggle", () => {
  it("uses custom clamp padding for both visible and measured text", async () => {
    await render("12px");

    const paragraphs = Array.from(
      container.querySelectorAll("p.MuiTypography-root"),
    );
    expect(paragraphs).toHaveLength(2);
    expect(
      paragraphs.map(
        (paragraph) => window.getComputedStyle(paragraph).paddingRight,
      ),
    ).toEqual(["12px", "12px"]);
  });

  it("applies the explicit right inset for the inline disclosure control", async () => {
    await render("56px", "12px");
    const button = window.getComputedStyle(requireToggleButton());
    expect(button.right).toBe("12px");
    expect(button.bottom).toBe("var(--app-spacing)");
  });

  it("moves the compact disclosure below text and removes reserved insets in narrow containers", async () => {
    await render("56px", "12px");
    const styles = styleText().replace(/\s+/g, "");
    expect(styles).toContain("@containertypography-with-more(max-width:480px)");
    expect(styles).toContain("position:static");

    const paragraphs = Array.from(
      container.querySelectorAll("p.MuiTypography-root"),
    );
    expect(paragraphs).toHaveLength(2);
    for (const paragraph of paragraphs) {
      const emotionClass = Array.from(paragraph.classList).find((className) =>
        className.startsWith("css-"),
      );
      if (!emotionClass) {
        throw new Error("Responsive text has no Emotion-generated class");
      }
      const narrowRules = styles
        .split("@containertypography-with-more(max-width:480px){")
        .filter((rule) => rule.startsWith(`.${emotionClass}{`));
      expect(narrowRules).toHaveLength(1);
      expect(narrowRules[0]).toContain("padding-right:0");
    }
  });

  it("renders collapsed with an inline 'Show more' whose hover is a link affordance, not a repaint of the fade", async () => {
    await render();
    const button = toggleButton();
    expect(button).not.toBeUndefined();
    expect(button?.textContent).toBe("Show more");

    const hover = hoverRulesFor(requireToggleButton());
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

    const hover = hoverRulesFor(requireToggleButton());
    const bgs = [...hover.matchAll(/background-color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(bgs[bgs.length - 1]).toContain("var(--app-palette-level2");
    expect(hover).not.toContain("text-decoration-color:currentColor");
  });

  it("reveals the affordance on keyboard focus, not hover alone", async () => {
    await render();
    const button = requireToggleButton();

    // A pointer user gets a state change on hover. A keyboard user tabbing to
    // the control used to see it stay de-emphasised, because the underline was
    // hover-only. The revealed state has to be identical on both.
    const focus = stateRulesFor(button, ":focus-visible");
    expect(focus).toContain("text-decoration-color:currentColor");
    const focusColors = [...focus.matchAll(/[;{]color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(focusColors[focusColors.length - 1]).toContain(
      "var(--app-palette-text-primary",
    );
  });

  it("paints the affordance at rest for a coarse touch pointer", async () => {
    await render();
    const button = requireToggleButton();

    // A touch device never fires :hover, so its resting state must retain
    // the inline link cue without leaking into no-pointer desktop screenshots.
    const touch = stateRulesFor(
      button,
      "@media (hover: none) and (pointer: coarse)",
    );
    expect(touch).toContain("text-decoration-color:currentColor");
  });

  it("gives the block toggle a focus state and a touch state too", async () => {
    await render();
    await act(async () => {
      toggleButton()?.click();
    });
    const button = requireToggleButton();

    const focus = stateRulesFor(button, ":focus-visible");
    const focusBgs = [...focus.matchAll(/background-color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(focusBgs[focusBgs.length - 1]).toContain("var(--app-palette-level2");

    const touch = stateRulesFor(button, "@media (hover: none)");
    const touchBgs = [...touch.matchAll(/background-color:([^;}]+)/g)].map(
      (m) => m[1],
    );
    expect(touchBgs[touchBgs.length - 1]).toContain("var(--app-palette-level2");
  });
});
