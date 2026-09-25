// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";
import { BouncyTooltip } from "./BouncyTooltip";

ensureUiHarness();

/** Emotion-injected rules, whole page (emission tags carry data-emotion). */
const styleText = () =>
  [...document.querySelectorAll("style[data-emotion]")]
    .map((el) => el.textContent ?? "")
    .join("\n");

const escapeRe = (value: string) =>
  value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/** Rules that belong to the classes worn by `element` (and its subtree). */
const cssForSubtree = (element: Element) => {
  const css = styleText();
  const rules: string[] = [];
  for (const el of [element, ...element.querySelectorAll("*")]) {
    for (const cls of (el.className as string).split(/\s+/)) {
      if (!cls.startsWith("css-")) continue;
      // [^{]* covers variant selectors like [data-mui-color-scheme=dark] .css-x
      const re = new RegExp(`\\.${escapeRe(cls)}[^{]*\\{[^}]*\\}`, "g");
      const matches = css.match(re);
      if (matches) rules.push(matches.join("\n"));
    }
  }
  return rules.join("\n");
};

describe("BouncyTooltip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setMatchMedia(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    setMatchMedia(false);
    container.remove();
  });

  const renderTooltip = async (visible: boolean) => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <BouncyTooltip visible={visible}>
            <span>Press your hotkey</span>
          </BouncyTooltip>
        </ThemeProvider>,
      );
    });
    const wrapper = container.querySelector("[class*='css-']");
    if (!wrapper) throw new Error("Tooltip did not render");
    return wrapper;
  };

  it("wears the app design language: neutral paper on the surface ladder, never an inverted slab", async () => {
    const wrapper = await renderTooltip(true);
    const css = cssForSubtree(wrapper);

    // Paper face comes from level1 with primary text, exactly like the
    // toast/header treatments. The old primary.main/contrastText inversion
    // must stay gone — it fought both color schemes.
    expect(css).toContain("background-color:var(--app-palette-level1)");
    expect(css).toContain("color:var(--app-palette-text-primary)");
    expect(css).toContain("border-bottom:8px solid var(--app-palette-level1)");
    expect(css).not.toContain("primary-contrastText");
    // Hairline + soft lift (ink shadows) for the light scheme, plus the dark
    // scheme override (white hairline, deeper shadows) so the bubble stays
    // legible on dark surfaces — both variants are emitted.
    expect(css).toContain("inset 0 0 0 1px rgba(26, 23, 18, 0.08)");
    expect(css).toContain("inset 0 0 0 1px rgba(255, 255, 255, 0.1)");
    // Bubble radius rides the theme's shape scale (one step = 14px), the
    // same rounding every Paper chip in the app gets.
    expect(css).toContain("border-radius:var(--app-shape-borderRadius)");
  });

  it("settles after two nudges instead of bouncing forever", async () => {
    const wrapper = await renderTooltip(true);
    const css = cssForSubtree(wrapper);

    expect(css).not.toContain("infinite");
    expect(css).toContain("0.25s ease-out");
    // Nudge: springy ease, finite iteration count of two.
    expect(css).toMatch(
      /animation:[^;]*cubic-bezier\(0\.34,\s*1\.4,\s*0\.64,\s*1\)[^;]*\b2\b/,
    );
  });

  it("keeps only the calm entrance under reduced motion", async () => {
    setMatchMedia(true);
    const wrapper = await renderTooltip(true);
    const css = cssForSubtree(wrapper);

    expect(css).toContain("0.25s ease-out");
    expect(css).not.toContain("1.6s");
  });

  it("fades down and out when dismissed after having been shown", async () => {
    const wrapper = await renderTooltip(true);
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <BouncyTooltip visible={false}>
            <span>Press your hotkey</span>
          </BouncyTooltip>
        </ThemeProvider>,
      );
    });
    const css = cssForSubtree(wrapper);

    expect(css).toContain("0.2s ease-in forwards");
  });
});
