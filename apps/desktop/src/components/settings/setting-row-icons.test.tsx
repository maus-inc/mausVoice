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
import { ThemeProvider } from "@mui/material";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { SettingGroup, SettingRow, SettingToggleRow } from "./SettingRow";
import { settingGlyphProps } from "./setting-row-chassis";

ensureUiHarness();

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
          // The app's theme provider, not a bare IntlProvider: without it the
          // rows fall back to stock MUI defaults, and every colour assertion
          // below would be checking MUI's palette instead of ours.
          createElement(
            ThemeProvider,
            { theme, ...THEME_PROVIDER_CONFIG },
            children as never,
          ),
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
      // A floor, not a fixed width: every glyph is 22px, so a glyph row still
      // measures the slot and the titles share one edge, while the one mark that
      // is wider, the identity avatar, widens its own slot instead of being
      // centred through its neighbours. The floor is the larger of the glyph size
      // and the slot the row already reserves for an icon, so a row without one
      // still starts its words on the same column.
      expect(rule).toContain("min-width:24px");
      expect(rule).not.toMatch(/[;{]width:\d+px/);
      expect(rule).toContain("flex-shrink:0");
      // The colour is the app's own `text.secondary`, not MUI's stock
      // `rgba(0, 0, 0, 0.6)`: the two happen to resolve close in light mode and
      // are nothing alike in dark, so the expectation comes from the palette
      // the app ships rather than from a literal.
      // A CSS variable, not a resolved literal: the theme turns the palette
      // token into `var(--app-palette-text-secondary)`, which is what makes the
      // glyph follow the scheme instead of freezing to the one that rendered it.
      expect(rule).toContain("color:var(--app-palette-text-secondary)");
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

    // The oracle is the palette token the theme compiled, not a literal red, so
    // a retuned scheme moves the rule with the app. The second row is the
    // negative control: same glyph, no tint.
    expect(ruleOf(glyphOf("clear_local_data"))).toContain(
      "color:var(--app-palette-error-main)",
    );
    expect(ruleOf(glyphOf("change_password"))).not.toContain(
      "color:var(--app-palette-error-main)",
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

  it("widens the lane for a wide avatar instead of centring it through its neighbours", () => {
    // The identity row leads with a 48px picture. Centred inside a fixed 22px
    // lane it reached 13px into the 16px gutter, leaving 3px of air against its
    // own title and 3px from the card edge, which reads as a crammed row. The
    // lane is a floor, so the avatar gets a 48px lane of its own and both
    // gutters stay at 16px.
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
    expect(lane).toContain("min-width:24px");
    // No centring: a centred child is what pushed the picture outside the lane.
    expect(lane).not.toContain("justify-content:center");

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
