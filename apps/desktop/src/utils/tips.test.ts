import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  settingAnchorId,
  settingsPagePath,
} from "../components/settings/settings-routes";
import { settingEntryOf, SETTINGS_PAGES } from "./settings-registry";
import { ONBOARDING_TIPS, tipAction, type OnboardingTip } from "./tips";

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

  it("gives every gated tip the label its setup action needs", () => {
    const source = readFileSync(
      new URL("../components/onboarding/TipCard.tsx", import.meta.url),
      "utf8",
    );
    const gated = ONBOARDING_TIPS.filter((tip) => tip.gate).length;
    const labelled = source.match(/setupAction:/g)?.length ?? 0;
    // A gate without its own label would render "Open chat" over a click that
    // opens settings, which is the same lie as the dead end this fixed.
    expect(labelled).toBe(gated);
  });

  it("gates the assistant tip on the assistant switch the row toggles", () => {
    expect(assistantTip.gate?.feature).toBe("assistantModeEnabled");
    expect(settingEntryOf("assistant_mode")?.page).toBe("ai-models");
    expect(assistantTip.gate?.setupHref).toBe(
      `${settingsPagePath("ai-models")}#${settingAnchorId("assistant_mode")}`,
    );
  });
});
