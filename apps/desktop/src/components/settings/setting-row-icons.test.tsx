// @vitest-environment jsdom
import { Mic, Volume2 } from "lucide-react";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { theme } from "../../theme";
import { SettingGroup, SettingRow, SettingToggleRow } from "./SettingRow";
import { settingGlyphProps } from "./setting-row-chassis";

ensureUiHarness();

/**
 * A palette hex as the computed style reports it.
 *
 * The comparison is against the palette token, not a literal, so retuning the
 * scheme moves both sides. jsdom hands back the resolved `rgb()` form while the
 * theme holds the authored hex, and that is the only reason for the conversion.
 */
const asComputedColor = (hex: string): string => {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16),
  );
  return `rgb(${r}, ${g}, ${b})`;
};

/**
 * The icon language of the settings surface, which no single row owns.
 *
 * Three row shapes share one card, and the issue that produced this suite was
 * an icon language that lapsed wherever the shapes alternated. What the tests
 * can hold is the contract: every row kind has a leading-glyph slot with the
 * same shape, the glyph stays out of the accessible name, and the lane is the
 * same width whether a glyph is present or not.
 */
/**
 * The generated CSS rule for one element, as the theme emitted it.
 *
 * jsdom resolves no layout and no descendant selectors, so a claim about the
 * lane's width or about a child staying at its own size cannot be read from a
 * computed box. The rule the app actually ships can, and that is the thing the
 * browser applies, so the assertions read the stylesheet and address the rule by
 * the class Emotion put on the element.
 */
const ruleOf = (element: Element): string => {
  const generated = Array.from(element.classList).find((name) =>
    name.startsWith("css-"),
  );
  if (!generated) throw new Error("element carries no generated class");
  const css = Array.from(document.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("");
  const start = css.indexOf(`.${generated}{`);
  if (start < 0) throw new Error(`no rule for .${generated}`);
  return css.slice(start, css.indexOf("}", start) + 1);
};

describe("settings row icons", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (children: ReactNode) =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          children as never,
        ),
      );
    });

  const glyphOf = (settingKey: string) =>
    requireElement(
      container.querySelector(`#setting-${settingKey} [aria-hidden="true"]`),
      `the ${settingKey} glyph`,
    );

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("draws a toggle row's glyph in the same lane as a row's", () => {
    render(
      <SettingGroup title="Microphone">
        <SettingRow
          settingKey="microphone"
          title="Microphone"
          icon={<Mic data-testid="row-glyph" {...settingGlyphProps} />}
        />
        <SettingToggleRow
          settingKey="spoken_commands"
          title="Spoken commands"
          icon={<Volume2 data-testid="toggle-glyph" {...settingGlyphProps} />}
          checked={false}
          onChange={() => undefined}
        />
      </SettingGroup>,
    );

    const rowGlyph = glyphOf("microphone");
    const toggleGlyph = glyphOf("spoken_commands");
    // The lane is the shared size, so the two titles start on one edge. The
    // assertion is on the CSS the theme generated, not on jsdom's layout, which
    // computes nothing.
    for (const glyph of [rowGlyph, toggleGlyph]) {
      const rule = ruleOf(glyph);
      // `width`, not `min-width`: a minimum lets a wider mark grow the lane and
      // start its title further right than every other row in the surface.
      expect(rule).toContain("width:22px");
      expect(rule).toContain("height:22px");
      expect(rule).not.toContain("min-width:22px");
      expect(rule).toContain("flex-shrink:0");
      expect(rule).toContain("color:rgba(0, 0, 0, 0.6)");
    }
  });

  it("keeps the glyph out of the switch's accessible name", () => {
    render(
      <SettingToggleRow
        settingKey="spoken_commands"
        title="Spoken commands"
        icon={<Volume2 {...settingGlyphProps} />}
        checked={false}
        onChange={() => undefined}
      />,
    );

    const input = requireElement(
      container.querySelector("#setting-spoken_commands input"),
      "the switch input",
    );
    expect(input.getAttribute("aria-labelledby")).toBe(
      "setting-spoken_commands-label",
    );
    // The glyph is a decoration beside the title, so the element that carries
    // it is hidden from assistive technology rather than named.
    expect(glyphOf("spoken_commands").getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the glyph from assistive technology on a row that opens a page", () => {
    render(
      <SettingRow
        settingKey="microphone"
        title="Microphone"
        icon={<Mic {...settingGlyphProps} />}
        onClick={() => undefined}
      />,
    );

    const row = requireElement(
      container.querySelector("#setting-microphone"),
      "the microphone row",
    );
    expect(row.tagName).toBe("BUTTON");
    expect(glyphOf("microphone").getAttribute("aria-hidden")).toBe("true");
  });

  it("tints a destructive row's glyph with the error colour", () => {
    render(
      <SettingGroup title="Danger zone" danger>
        <SettingRow
          settingKey="clear_local_data"
          title="Clear local data"
          icon={<Mic {...settingGlyphProps} />}
          iconTone="danger"
        />
        <SettingRow
          settingKey="change_password"
          title="Change password"
          icon={<Mic {...settingGlyphProps} />}
        />
      </SettingGroup>,
    );

    // The oracle is the palette token, not a literal, so a retuned scheme moves
    // the expectation with the app instead of failing on a number. The second
    // row is the negative control: same glyph, no tint.
    const errorColor = asComputedColor(theme.palette.error.main);
    expect(getComputedStyle(glyphOf("clear_local_data")).color).toBe(
      errorColor,
    );
    expect(getComputedStyle(glyphOf("change_password")).color).not.toBe(
      errorColor,
    );
  });

  it("keeps the label block as the row's wrap target when a glyph is present", () => {
    render(
      <SettingRow
        settingKey="hands_free_output_delay"
        title="Hands-free output delay"
        icon={<Mic {...settingGlyphProps} />}
        control={createElement("button", null, "Field")}
      />,
    );

    const row = requireElement(
      container.querySelector("#setting-hands_free_output_delay"),
      "the row",
    );
    const label = requireElement(
      row.querySelector(".setting-row-label"),
      "the label block",
    );
    expect(getComputedStyle(row).flexWrap).toBe("wrap");
    expect(getComputedStyle(label).flexBasis).toBe("min(200px, 100%)");
  });

  it("keeps a wide avatar overhanging the lane instead of widening it", () => {
    // The identity row leads with a 48px picture. If the lane grew to fit it,
    // that one title would start 26px right of every other title on the
    // surface, which is the misalignment the lane exists to remove. A fixed
    // lane plus a centred, non-shrinking child is what keeps the title edge
    // common and the face uncropped.
    render(
      <SettingGroup title="Profile">
        <SettingRow
          settingKey="name"
          title="Name"
          icon={createElement("span", { "data-testid": "avatar" })}
        />
      </SettingGroup>,
    );

    const glyph = glyphOf("name");
    const lane = ruleOf(glyph);
    expect(lane).toContain("width:22px");
    expect(lane).toContain("justify-content:center");

    // The guard that keeps a 48px picture whole inside a 22px lane: without it
    // the avatar is a flex item that shrinks to the lane and the face is cut.
    const generated = Array.from(glyph.classList).find((name) =>
      name.startsWith("css-"),
    );
    const css = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("");
    expect(css).toContain(`.${generated}>*{`);
    expect(css).toMatch(new RegExp(`\\.${generated}>\\*\\{[^}]*flex-shrink:0`));
  });
});
