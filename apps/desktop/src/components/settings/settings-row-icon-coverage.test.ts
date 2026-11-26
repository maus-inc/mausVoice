import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_PAGES,
  type SettingsPageId,
} from "../../utils/settings-registry";

/**
 * The audit the settings icon language depends on.
 *
 * The issue that produced this suite named a handful of rows that had no
 * leading icon, and the rows it did not name were the real size of the job. A
 * behavioural test cannot see a missing prop, so this reads the sources the
 * same way `settings-registry.test.ts` does: every row a page renders has to
 * declare an icon, and the icons have to be drawn from one family at one size.
 */

const REPO_ROOT = new URL("../../../../../", import.meta.url);

const readSource = (relative: string) =>
  readFileSync(new URL(relative, REPO_ROOT), "utf8");

function pageFileOf(page: SettingsPageId): string {
  const pascal = page
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return `apps/desktop/src/components/settings/pages/${pascal}SettingsPage.tsx`;
}

/**
 * Every file that renders an anchored settings row.
 *
 * The three standalone components own rows their page renders, so leaving them
 * out would make the audit silently incomplete, which is the failure mode this
 * suite exists to catch.
 */
const ROW_SOURCES = [
  ...SETTINGS_PAGES.map((page) => pageFileOf(page.id)),
  "apps/desktop/src/components/settings/PillPlacementSetting.tsx",
  "apps/desktop/src/components/settings/UpdateSettingSection.tsx",
  "apps/desktop/src/components/settings/UpdateChannelSetting.tsx",
];

/**
 * The opening tag of every row element in a source, including its props.
 *
 * The scan tracks brace depth because a row's props are full of JavaScript:
 * an arrow in a callback writes `>` and a JSX child writes `<`, and a naive
 * counter reads both as tag boundaries and returns half a row. Outside braces,
 * the first `>` that is not part of a `/>` closes the tag.
 */
const rowBlocks = (source: string): string[] => {
  const blocks: string[] = [];
  for (const match of source.matchAll(/<(SettingRow|SettingToggleRow)\b/g)) {
    let index = match.index;
    let braces = 0;
    let quote: string | null = null;
    while (index < source.length) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== "\\") quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      else if (char === ">" && braces === 0) break;
      index += 1;
    }
    blocks.push(source.slice(match.index, index + 1));
  }
  return blocks;
};

const settingKeyOf = (block: string): string | null =>
  /settingKey="([a-z0-9_]+)"/.exec(block)?.[1] ?? null;

/** The element a row passes as its leading mark, when it passes one. */
const glyphOf = (block: string): string | null =>
  /icon=\{\s*<([A-Za-z0-9]+)/.exec(block)?.[1] ?? null;

describe("settings row icon coverage", () => {
  const sources = ROW_SOURCES.map((path) => ({
    path,
    source: readSource(path),
  }));

  it("gives every row on every page a leading glyph", () => {
    const missing: string[] = [];
    for (const { path, source } of sources) {
      for (const block of rowBlocks(source)) {
        if (glyphOf(block) === null) {
          missing.push(`${path}: ${settingKeyOf(block) ?? "unnamed row"}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("draws every glyph at the shared settings size and stroke", () => {
    // Two kinds of leading mark are not a lucide glyph and carry no size of
    // their own to get wrong: a provider's own artwork, which is fitted into a
    // square, and the person's avatar, which is identity rather than an icon.
    const overdrawn: string[] = [];
    for (const { path, source } of sources) {
      for (const block of rowBlocks(source)) {
        const leadsWithOwnMark =
          block.includes("settingGlyphProps") ||
          block.includes("<ProviderLogo") ||
          block.includes("<UserAvatar");
        if (!leadsWithOwnMark) {
          overdrawn.push(`${path}: ${settingKeyOf(block) ?? "unnamed row"}`);
        }
      }
    }
    expect(overdrawn).toEqual([]);
  });

  it("draws no glyph from a second icon family", () => {
    // DESIGN.md allows one family per pane. This is the half a size assertion
    // cannot see: a Material microphone at 22px is the right size and still the
    // wrong drawing, and the difference shows in the stroke alone.
    const material = sources
      .filter(({ source }) => source.includes("@mui/icons-material"))
      .map(({ path }) => path);
    expect(material).toEqual([]);
  });
});
