import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_SECTIONS } from "./settings-registry";

const pageSource = readFileSync(
  new URL("../components/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

/**
 * The registry is the single source of truth for which sections exist and in
 * what order. The page renders one wrapper anchor per section and the rail one
 * entry per section, so if either drifts the result is a rail button that
 * scrolls nowhere or highlights a section that does not exist.
 */
describe("settings section anchors", () => {
  it.each(SETTING_SECTIONS.map((entry) => [entry.id]))(
    "renders the section-%s wrapper the rail scrolls to",
    (id) => {
      expect(pageSource).toContain(`id="section-${id}"`);
    },
  );

  it("renders exactly one wrapper per registry section", () => {
    const anchors = pageSource.match(/id="section-[a-z-]+"/g) ?? [];
    expect(anchors).toHaveLength(SETTING_SECTIONS.length);
  });

  it("renders the sections in registry order, so the rail order matches the page", () => {
    const order = Array.from(
      pageSource.matchAll(/id="section-([a-z-]+)"/g),
    ).map((match) => match[1]);
    expect(order).toEqual(SETTING_SECTIONS.map((entry) => entry.id));
  });

  it("mounts the navigation rail on the settings page", () => {
    expect(pageSource).toContain("<SettingsSectionNav");
  });

  it("keeps the rail out of the search-results view", () => {
    // The rail scrolls to sections the search view replaces, so showing both at
    // once would leave a visible control that does nothing.
    const conditional = pageSource.slice(
      pageSource.indexOf("query.trim() ?"),
      pageSource.indexOf("<SettingsSectionNav"),
    );
    expect(conditional).not.toContain("SettingsSectionNav");
  });
});
