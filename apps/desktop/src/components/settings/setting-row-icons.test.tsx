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
      expect(getComputedStyle(glyph).minWidth).toBe("22px");
      expect(getComputedStyle(glyph).flexShrink).toBe("0");
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
});
