import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The one row kind that is not a setting.
 *
 * The shortcuts card and its dialog summarise keys a person has already bound.
 * Their leading content is the keycap cluster, so a glyph there would be a
 * second mark for the same thing, and the design document says so. Naming the
 * exception here rather than filtering it out silently keeps it reviewable: a
 * new iconless surface has to be added to this list, which is a sentence
 * someone has to justify.
 */
const IS_KEY_SUMMARY = "home/QuickShortcutsCard.tsx";

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

/**
 * Every file that renders one of these rows, found rather than listed.
 *
 * A hand-written list is the failure this suite exists to catch: a new page
 * joins and nobody remembers to add its path, so the audit reports a clean tree
 * while the newest surface has no glyphs at all. The walk reads the settings
 * folder and keeps whatever renders a `SettingRow`, a `SettingToggleRow` or an
 * overview row, so a new file is audited the moment it exists.
 */
const discoveredRowSources = (
  dir: URL = new URL("apps/desktop/src/components/settings/", REPO_ROOT),
): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      dir,
    );
    if (entry.isDirectory()) return discoveredRowSources(child);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) {
      return [];
    }
    const source = readFileSync(child, "utf8");
    const rendersRow =
      /<(SettingRow|SettingToggleRow|SettingSummaryRow)\b/.test(source);
    return rendersRow ? [fileURLToPath(child)] : [];
  });

/**
 * Every `.tsx` source under a directory, test files excluded, with its text.
 *
 * The row walk stops at files that render a row, which is the right scope for
 * "does this row lead with a glyph". The icon-family rule is broader than that:
 * a dialog belongs to the pane it opens over, so it is read even though it
 * renders no row of its own.
 */
const everySource = (dir: URL): { path: string; source: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return everySource(new URL(`${entry.name}/`, dir));
    }
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) {
      return [];
    }
    return [
      {
        path: entry.name,
        source: readFileSync(new URL(entry.name, dir), "utf8"),
      },
    ];
  });

const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT);

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
  // Every row kind the settings tree renders, including the overview's own:
  // a summary row leads a card the same way a page row leads a list, and it was
  // the one shape this walk could see but not read.
  for (const match of source.matchAll(
    /<(SettingRow|SettingToggleRow|SettingSummaryRow)\b/g,
  )) {
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

/**
 * Whether the row routes its mark through a helper that owns the choice.
 *
 * The helper has to appear inside the `icon` initializer. Scanning the whole
 * row block would accept a row whose *control* happens to call the helper while
 * the icon itself is missing, which is the same defect class as reading the
 * wrong prop: a row that draws no leading mark passes because its neighbour's
 * code is nearby.
 */
const leadsWithMarkHelper = (block: string): boolean => {
  const initializer = iconInitializerOf(block);
  return (
    initializer !== null &&
    LEADING_MARK_HELPERS.some((helper) => initializer.includes(helper))
  );
};

/** The key a row is known by: its anchor, or the page a summary row opens. */
const settingKeyOf = (block: string): string | null =>
  /settingKey="([a-z0-9_]+)"/.exec(block)?.[1] ??
  /linksTo="([a-z0-9_]+)"/.exec(block)?.[1] ??
  null;

/** The whole opening tag of each row, parsed into the props it passes. */
const rowOf = (source: string): string => {
  const [block] = rowBlocks(source);
  return block ?? "";
};

/** The `icon={...}` initializer of a row, from `{` to its matching `}`. */
const iconInitializerOf = (block: string): string | null => {
  const start = /\bicon=\{/.exec(block);
  if (!start) return null;
  let index = start.index + start[0].length;
  let depth = 1;
  const from = index;
  while (index < block.length && depth > 0) {
    if (block[index] === "{") depth += 1;
    else if (block[index] === "}") depth -= 1;
    index += 1;
  }
  return block.slice(from, index - 1);
};

/** The one JSX element inside an icon initializer, when it is exactly one. */
const iconElementOf = (initializer: string): string | null => {
  const start = initializer.indexOf("<");
  if (start < 0) return null;
  let index = start;
  let braces = 0;
  while (index < initializer.length) {
    if (initializer[index] === "{") braces += 1;
    else if (initializer[index] === "}") braces -= 1;
    else if (initializer[index] === ">" && braces === 0) break;
    index += 1;
  }
  return initializer.slice(start, index + 1);
};

/** Props that would re-set the size or stroke the shared object already set. */
const hasOwnSizing = (element: string): boolean =>
  /\b(size|strokeWidth|fontSize)\s*=/.test(element);

/**
 * Whether a row's leading mark is drawn from the shared props.
 *
 * The element is inspected rather than the whole row block, because the two are
 * not the same claim: a row whose *control* mentions `settingGlyphProps` while
 * its icon carries its own `size` satisfies the looser check and still draws a
 * glyph at the wrong scale.
 */
const leadsWithGlyphProps = (block: string): boolean => {
  const initializer = iconInitializerOf(block);
  if (initializer === null) return false;
  const element = iconElementOf(initializer);
  if (element === null) return false;
  // A provider's own artwork and the person's picture are identity rather than
  // icons: they carry no stroke of their own, and their size is about the mark
  // (a face is 48px, a logo 22px), not about the icon scale this rule holds.
  if (/^<(ProviderLogo|UserAvatar)\b/.test(element)) return true;
  if (hasOwnSizing(element)) return false;
  return /\{\.\.\.settingGlyphProps\}/.test(element);
};

/**
 * The leading mark a row passes, when it passes one.
 *
 * The identity row and the models card both route their mark through a helper
 * that decides between a provider logo and a glyph at render time, so the mark
 * is an expression rather than an element literal. That is still a named
 * decision the row makes, and `leadsWithGlyphProps` reads the helper itself, so
 * the row is not skipped for not spelling the element out.
 */
const LEADING_MARK_HELPERS = ["leadingGlyph("];

/** The element a row passes as its leading mark, when it passes one. */
const glyphOf = (block: string): string | null =>
  /icon=\{\s*<([A-Za-z0-9]+)/.exec(block)?.[1] ?? null;

describe("settings row icon coverage", () => {
  const sources = discoveredRowSources()
    .map((absolute) => ({
      path: relative(REPO_ROOT_PATH, absolute).replaceAll("\\", "/"),
      source: readFileSync(absolute, "utf8"),
    }))
    .filter(({ path }) => !path.endsWith(IS_KEY_SUMMARY));

  it("gives every row on every page a leading glyph", () => {
    const missing: string[] = [];
    for (const { path, source } of sources) {
      for (const block of rowBlocks(source)) {
        if (glyphOf(block) === null && !leadsWithMarkHelper(block)) {
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
        if (!leadsWithGlyphProps(block) && !leadsWithMarkHelper(block)) {
          overdrawn.push(`${path}: ${settingKeyOf(block) ?? "unnamed row"}`);
        }
      }
    }
    expect(overdrawn).toEqual([]);
  });

  it("rejects a glyph that overrides the shared size or stroke", () => {
    // The check above would pass on `<Mic {...settingGlyphProps} size={40} />`
    // and on a row whose *control* spread the props, so the extraction has to be
    // held to its own standard. A spread before a literal is an override in
    // JSX, so it is rejected the same way the literal alone is.
    expect(
      leadsWithGlyphProps(rowOf("<SettingRow icon={<Mic size={40} />} />")),
    ).toBe(false);
    expect(
      leadsWithGlyphProps(
        rowOf("<SettingRow icon={<Mic {...settingGlyphProps} size={40} />} />"),
      ),
    ).toBe(false);
    expect(
      leadsWithGlyphProps(
        rowOf('<SettingRow title="x" icon={<Mic {...settingGlyphProps} />} />'),
      ),
    ).toBe(true);
    // A spread of some other object is not the shared props, whatever it holds.
    expect(
      leadsWithGlyphProps(
        rowOf("<SettingRow icon={<Mic {...glyphProps} />} />"),
      ),
    ).toBe(false);
    // A helper is a named decision, but only when it is what the row passes as
    // its mark: the same call in `control` must not rescue a row with no icon.
    expect(
      leadsWithMarkHelper(
        rowOf(
          '<SettingRow icon={leadingGlyph(summary, AudioLines)} title="x" />',
        ),
      ),
    ).toBe(true);
    expect(
      leadsWithMarkHelper(
        rowOf(
          '<SettingRow control={leadingGlyph(summary, AudioLines)} title="x" />',
        ),
      ),
    ).toBe(false);

    // A provider mark is fitted into its own square rather than drawn at the
    // glyph size, so it is allowed as a leading mark and needs no spread.
    expect(
      leadsWithGlyphProps(
        rowOf(
          '<SettingRow icon={<ProviderLogo provider="groq" size={22} />} />',
        ),
      ),
    ).toBe(true);
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

  it("finds every surface that renders a row, including a new one", () => {
    // The discovery, not the rule, is what a future page can defeat: a file the
    // walk never opens is a file no assertion can fail on. These are the paths
    // the audit is known to cover, and a surface that renders rows without
    // appearing here means the walk broke, not that the surface is fine.
    expect(sources.map(({ path }) => path).sort()).toEqual([
      "apps/desktop/src/components/settings/PillPlacementSetting.tsx",
      "apps/desktop/src/components/settings/UpdateChannelSetting.tsx",
      "apps/desktop/src/components/settings/UpdateSettingSection.tsx",
      "apps/desktop/src/components/settings/home/YourModelsCard.tsx",
      "apps/desktop/src/components/settings/pages/AccountSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/AiModelsSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/AppearanceSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/DictationSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/PrivacyDataSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/ShortcutsSettingsPage.tsx",
      "apps/desktop/src/components/settings/pages/SystemSettingsPage.tsx",
    ]);
  });

  it("holds the models card's own mark helper to the same size", () => {
    // The three summary rows hand their mark to a helper that chooses between a
    // provider's artwork and a glyph, so the row blocks themselves carry no
    // element to inspect. The decision still has to draw at the shared size,
    // and that is the line this assertion reads.
    const card = readFileSync(
      `${REPO_ROOT_PATH}apps/desktop/src/components/settings/home/YourModelsCard.tsx`,
      "utf8",
    );
    expect(card).toContain("<Glyph {...settingGlyphProps} />");
    expect(card).toContain("<ProviderLogo provider={summary.provider}");

    // And a summary row with no mark at all fails the same way a page row does.
    expect(
      glyphOf(rowOf('<SettingSummaryRow linksTo="ai_transcription" />')),
    ).toBe(null);
  });

  it("draws no Material icon anywhere in the settings surface", () => {
    // The design document says lucide is the only icon family, with Material
    // surviving only inside the sanctioned third-party mockups. A row can lead
    // with a lucide glyph and still show a Material one in the dialog it opens,
    // which is the same pane to the person who opened it. This reads every
    // source in the folder, dialogs and pickers included, so the rule has one
    // place to hold rather than one per surface.
    const settingsRoot = new URL(
      "apps/desktop/src/components/settings/",
      REPO_ROOT,
    );
    const offenders = everySource(settingsRoot)
      .filter(({ source }) => source.includes("@mui/icons-material"))
      .map(({ path }) =>
        relative(REPO_ROOT_PATH, fileURLToPath(new URL(path, settingsRoot))),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps the colour each migrated glyph used to inherit from MUI", () => {
    // MUI's icons took `color="warning"`, `color="disabled"` and `color="action"`,
    // and lucide draws in `currentColor` with no default tone of its own. Swapping
    // the component therefore dropped six tones on the floor: a power-mode warning
    // lost its caution, four hotkey controls drew at full contrast while disabled,
    // and the model picker's chevron and search glyph lost their muted action tone.
    // Each of those sites now names a palette variable, and this holds them to it so
    // a later edit cannot quietly make a glyph inherit its neighbour's colour again.
    const settingsRoot = new URL(
      "apps/desktop/src/components/settings/",
      REPO_ROOT,
    );
    const required: Record<string, string[]> = {
      "AIAgentModeDialog.tsx": ["--app-palette-warning-main"],
      "OpenRouterModelPicker.tsx": [
        "--app-palette-text-secondary",
        "--app-palette-text-secondary",
      ],
      "HotkeySetting.tsx": ["settingDisabledGlyphProps"],
    };

    for (const [file, tones] of Object.entries(required)) {
      const source = everySource(settingsRoot).find(
        ({ path }) => path === file,
      )?.source;
      expect(source, file).toBeTruthy();
      for (const tone of tones) {
        expect(source, `${file} keeps ${tone}`).toContain(tone);
      }
    }

    // The disabled tone has one home, so the next disabled glyph uses it.
    const chassis = everySource(settingsRoot).find(
      ({ path }) => path === "setting-row-chassis.tsx",
    )?.source;
    expect(chassis).toContain("settingDisabledGlyphProps");
    expect(chassis).toContain("var(--app-palette-action-disabled)");
  });

  it("gives every lucide glyph in the settings surface the shared stroke", () => {
    // Lucide 0.544.0 defaults `strokeWidth` to 2, not to the 1.9 the surface
    // draws. The row checks above only see a row's leading mark, so a glyph in a
    // dialog, a picker, a button's `startIcon` or a well's empty state could carry
    // the library default and look heavier than the row it sits behind. This reads
    // every element of an imported lucide component in the folder and demands the
    // shared stroke, which is the line the migrated glyphs crossed.
    const settingsRoot = new URL(
      "apps/desktop/src/components/settings/",
      REPO_ROOT,
    );
    const offenders: string[] = [];

    for (const { path, source } of everySource(settingsRoot)) {
      const imported = new Set<string>();
      for (const match of source.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*"lucide-react"/gu,
      )) {
        for (const name of match[1].split(",")) {
          const trimmed = name.trim();
          if (trimmed) imported.add(trimmed);
        }
      }
      if (imported.size === 0) continue;

      for (const match of source.matchAll(/<([A-Za-z0-9]+)\b([^>]*)>/gu)) {
        const [, name, props] = match;
        if (!imported.has(name)) continue;
        // A spread of the shared props carries the stroke; a literal 1.9 is the
        // same value spelled out; anything else inherits lucide's own default.
        if (
          props.includes("settingGlyphProps") ||
          props.includes("settingSearchGlyphProps") ||
          props.includes("settingDisabledGlyphProps") ||
          /strokeWidth=\{\s*1\.9\s*\}/u.test(props)
        ) {
          continue;
        }
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${path}:${line} <${name}> without the shared stroke`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
