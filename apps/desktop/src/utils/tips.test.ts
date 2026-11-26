import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  settingAnchorId,
  settingsPagePath,
} from "../components/settings/settings-routes";
import { settingEntryOf, SETTINGS_PAGES } from "./settings-registry";
import { ONBOARDING_TIPS, tipAction, type OnboardingTip } from "./tips";

/**
 * The `TIP_COPY` literals in `TipCard.tsx`, keyed by tip id, with the default
 * message text of each label.
 *
 * Reading the map is what makes the assertion per tip. Importing the module
 * would be better still, but it pulls MUI, react-intl and a PNG into a plain
 * node test file for the sake of two strings, and the source is the thing that
 * decides which literal sits under which id.
 */
const TIP_COPY_SOURCE = (
  source: string,
): Map<string, { action?: string; setupAction?: string }> => {
  const start = source.indexOf("export const TIP_COPY");
  if (start < 0) throw new Error("TIP_COPY is not in TipCard.tsx");
  const body = source.slice(start);
  const entries = new Map<string, { action?: string; setupAction?: string }>();

  // Each tip is a quoted id followed by its object, up to the next quoted id.
  const idPattern = /^  "([a-z-]+)": \{$/gm;
  const matches = [...body.matchAll(idPattern)];
  matches.forEach((match, index) => {
    const from = match.index ?? 0;
    const to = matches[index + 1]?.index ?? body.length;
    const block = body.slice(from, to);
    const text = (field: string): string | undefined =>
      new RegExp(`${field}: <FormattedMessage defaultMessage="([^"]+)"`).exec(
        block,
      )?.[1];
    entries.set(match[1], {
      action: text("action"),
      setupAction: text("setupAction"),
    });
  });
  return entries;
};

/**
 * A tip's action is a destination, and one of them sits behind a feature switch.
 * These pin both answers, so the Help listing cannot send someone into a
 * feature that is off the way it did in issue #355.
 */
describe("tip actions", () => {
  const assistantTip = ONBOARDING_TIPS.find(
    (tip) => tip.id === "assistant-mode",
  ) as OnboardingTip;

  it("opens the feature while it is on", () => {
    expect(tipAction(assistantTip, { assistantModeEnabled: true })).toEqual({
      href: "/dashboard/chats",
      isSetup: false,
    });
  });

  it("opens the setting that turns the feature on while it is off", () => {
    expect(tipAction(assistantTip, { assistantModeEnabled: false })).toEqual({
      href: "/dashboard/settings/ai-models#setting-assistant_mode",
      isSetup: true,
    });
  });

  it("leaves an ungated tip on its own route either way", () => {
    const styles = ONBOARDING_TIPS.find((tip) => tip.id === "writing-styles");
    if (!styles) throw new Error("Expected the writing-styles tip");
    for (const assistantModeEnabled of [true, false]) {
      expect(tipAction(styles, { assistantModeEnabled })?.href).toBe(
        "/dashboard/styling",
      );
    }
  });

  it("reports no action for a tip that has nowhere to go", () => {
    expect(
      tipAction({ id: "writing-styles" }, { assistantModeEnabled: true }),
    ).toBeNull();
  });

  /*
   * The class-level half: a gated destination is only usable if the row it
   * names is registered and the page that owns it really renders that anchor,
   * which `settings-registry.test.ts` keeps true for every registered key. A
   * setup link spelled by hand would pass a navigation assertion and still land
   * on a page with no such row.
   */
  it("points every gated tip at a registered setting row", () => {
    const pagePaths = new Set(
      SETTINGS_PAGES.map((page) => settingsPagePath(page.id)),
    );

    for (const tip of ONBOARDING_TIPS) {
      if (!tip.gate) continue;
      const [path, hash] = tip.gate.setupHref.split("#");
      expect(pagePaths, `${tip.id} opens a registered page`).toContain(path);

      const anchor = hash?.slice("setting-".length);
      const entry = anchor ? settingEntryOf(anchor) : undefined;
      expect(entry, `${tip.id} opens a registered setting`).toBeDefined();
      expect(hash, `${tip.id} names the anchor by key`).toBe(
        settingAnchorId(entry?.key ?? ""),
      );
      expect(settingsPagePath(entry?.page ?? "home"), `${tip.id} page`).toBe(
        path,
      );
      // A switch with no row of its own is a dead link behind a label that
      // promises a control.
      expect(entry?.key, `${tip.id} names its own row`).toBe(
        tip.gate.feature === "assistantModeEnabled"
          ? "assistant_mode"
          : entry?.key,
      );
    }
  });

  /*
   * The class level, part two: the resolver is only the one place a tip action
   * is decided if the surface that navigates asks it. The Help page read
   * `tip.href` straight off the table and skipped the switch entirely, which is
   * what issue #355 was, and a rendered assertion cannot see that: it would
   * pass on a page that resolves the switch and fail on one that hard-codes a
   * route, whatever the resolver says. So this reads the sources.
   */
  it("leaves no surface navigating from the tip table directly", () => {
    const offenders: string[] = [];
    const walk = (directory: URL): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = new URL(
          `${entry.name}${entry.isDirectory() ? "/" : ""}`,
          directory,
        );
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          if (/navigate\([^)]*tip\.href/.test(readFileSync(path, "utf8"))) {
            offenders.push(path.pathname);
          }
        }
      }
    };
    walk(new URL("../", import.meta.url));
    expect(
      offenders,
      "these navigate from the tip table, not its resolver",
    ).toEqual([]);

    const help = readFileSync(
      new URL("../components/help/HelpPage.tsx", import.meta.url),
      "utf8",
    );
    expect(help).toMatch(/tipAction\(/);
  });

  /*
   * The label is per tip, not a headcount. Counting `setupAction:` occurrences
   * against the number of gated tips passes when the label moves to an ungated
   * tip, and the gated one silently falls back to "Open chat" over a click that
   * opens settings — the same lie as the dead end this fixed. So this reads the
   * copy map itself and asks which tip owns which label.
   */
  it("gives each gated tip its own setup label and leaves the rest alone", () => {
    const source = readFileSync(
      new URL("../components/onboarding/TipCard.tsx", import.meta.url),
      "utf8",
    );
    const copy = TIP_COPY_SOURCE(source);
    const gated = ONBOARDING_TIPS.filter((tip) => tip.gate);

    // A gated tip's button opens the setting row, so its label has to name that
    // destination rather than the feature's own page.
    for (const tip of gated) {
      const tipCopy = copy.get(tip.id);
      expect(tipCopy, `${tip.id} has copy`).toBeDefined();
      expect(
        tipCopy?.setupAction,
        `${tip.id} labels its setup action`,
      ).toBeDefined();
      expect(tipCopy?.setupAction, `${tip.id} names where the click goes`).toBe(
        "Open settings",
      );
      expect(
        tipCopy?.action,
        `${tip.id} keeps the enabled label separate`,
      ).not.toBe(tipCopy?.setupAction);
    }

    // Nothing that stays on its own route grows a label describing a detour:
    // an ungated tip with a setup label is the misplacement above, seen from
    // the other side.
    for (const [id, tipCopy] of copy) {
      if (gated.some((tip) => tip.id === id)) continue;
      expect(tipCopy.setupAction, `${id} has no setup label`).toBeUndefined();
    }
  });

  it("gates the assistant tip on the assistant switch the row toggles", () => {
    expect(assistantTip.gate?.feature).toBe("assistantModeEnabled");
    expect(settingEntryOf("assistant_mode")?.page).toBe("ai-models");
    expect(assistantTip.gate?.setupHref).toBe(
      `${settingsPagePath("ai-models")}#${settingAnchorId("assistant_mode")}`,
    );
  });
});
