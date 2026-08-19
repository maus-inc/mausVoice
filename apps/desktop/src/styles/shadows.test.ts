import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accentSurface, premiumSurface, titleBarShadow } from "./shadows";

/**
 * Contract tests for the layered-surface shadow language (DESIGN.md:
 * "premiumSurface = 2px inner top highlight (emboss) + multi-stop soft drop
 * shadow"). One language, two modes: identical stop geometry in light and
 * dark, mode-tuned inks (warm `ink` in light, neutral black in dark), with
 * A14's light emboss alphas and A16's mirrored light drop stops pinned so
 * future tuning has to be deliberate.
 */

type Layer = {
  inset: boolean;
  ox: number;
  oy: number;
  blur: number;
  color: string;
  alpha: number;
};

const RGBA_RE = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/;
const LAYER_RE =
  /(inset\s+)?(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?(?:\s+(-?\d+(?:\.\d+)?)(?:px)?)?\s+(rgba\([^)]*\))/g;

const parseLayers = (token: string): Layer[] =>
  Array.from(token.matchAll(LAYER_RE)).map((m) => {
    const color = m[6];
    return {
      inset: !!m[1],
      ox: Number(m[2]),
      oy: Number(m[3]),
      blur: Number(m[4]),
      color,
      alpha: Number(color.match(RGBA_RE)?.[4]),
    };
  });

const insets = (token: string) => parseLayers(token).filter((l) => l.inset);
const drops = (token: string) => parseLayers(token).filter((l) => !l.inset);
const geometry = (ls: Layer[]) => ls.map(({ ox, oy, blur }) => [ox, oy, blur]);
const rgb = (l: Layer) => l.color.match(RGBA_RE)?.slice(1, 4).join(", ");

const modes = ["light", "dark"] as const;
const states = ["rest", "hover", "active", "selected"] as const;

describe("premiumSurface: one language, two modes", () => {
  it.each(states)(
    "%s has the same emboss rows and drop stops in both modes",
    (state) => {
      const light = parseLayers(premiumSurface.light[state]);
      const dark = parseLayers(premiumSurface.dark[state]);
      expect(insets(premiumSurface.light[state])).toHaveLength(2);
      expect(insets(premiumSurface.dark[state])).toHaveLength(2);
      // Emboss rows: 1px crisp rim + 2px halo, always from the top. Active
      // leads with the press inset instead, so the rim is second there.
      for (const mode of modes) {
        const ls = insets(premiumSurface[mode][state]);
        const rim = ls[state === "active" ? 1 : 0];
        const other = ls[state === "active" ? 0 : 1];
        expect([rim.ox, rim.oy, rim.blur]).toEqual([0, 1, 0]);
        expect([other.ox, other.oy]).toEqual([0, 2]);
      }
      // Drop stops mirror each other exactly (A16).
      expect(geometry(drops(premiumSurface.light[state]))).toEqual(
        geometry(drops(premiumSurface.dark[state])),
      );
      // Layer order is stable: emboss insets first, drops after.
      expect(light.map((l) => l.inset)).toEqual(dark.map((l) => l.inset));
    },
  );

  it.each(states)(
    "%s casts warm ink in light and neutral black in dark",
    (state) => {
      for (const drop of drops(premiumSurface.light[state])) {
        expect(rgb(drop)).toBe("26, 23, 18");
      }
      for (const drop of drops(premiumSurface.dark[state])) {
        expect(rgb(drop)).toBe("0, 0, 0");
      }
    },
  );

  it("emboss rows are white in both modes; the press inset uses the scheme ink", () => {
    for (const mode of modes) {
      for (const state of states) {
        for (const inset of insets(premiumSurface[mode][state])) {
          if (inset.oy === 1) expect(rgb(inset)).toBe("255, 255, 255");
        }
      }
      const lightPress = insets(premiumSurface.light.active)[0];
      const darkPress = insets(premiumSurface.dark.active)[0];
      expect(rgb(lightPress)).toBe("26, 23, 18");
      expect(rgb(darkPress)).toBe("0, 0, 0");
    }
  });

  it("keeps A14's light-mode emboss alphas", () => {
    expect(insets(premiumSurface.light.rest).map((l) => l.alpha)).toEqual([
      0.42, 0.14,
    ]);
    expect(insets(premiumSurface.light.hover).map((l) => l.alpha)).toEqual([
      0.58, 0.2,
    ]);
    expect(insets(premiumSurface.light.active).map((l) => l.alpha)).toEqual([
      0.07, 0.18,
    ]);
    expect(insets(premiumSurface.light.selected).map((l) => l.alpha)).toEqual([
      0.18, 0.06,
    ]);
  });

  it("keeps dark-mode emboss alphas unchanged", () => {
    expect(insets(premiumSurface.dark.rest).map((l) => l.alpha)).toEqual([
      0.08, 0.03,
    ]);
    expect(insets(premiumSurface.dark.hover).map((l) => l.alpha)).toEqual([
      0.12, 0.05,
    ]);
    expect(insets(premiumSurface.dark.active).map((l) => l.alpha)).toEqual([
      0.45, 0.04,
    ]);
    expect(insets(premiumSurface.dark.selected).map((l) => l.alpha)).toEqual([
      0.14, 0.05,
    ]);
  });

  it("mirrors dark's drop structure with warm ink (A16)", () => {
    expect(drops(premiumSurface.light.rest).map((l) => l.alpha)).toEqual([
      0.1, 0.12, 0.1,
    ]);
    expect(drops(premiumSurface.light.hover).map((l) => l.alpha)).toEqual([
      0.12, 0.16, 0.13,
    ]);
    expect(drops(premiumSurface.light.active).map((l) => l.alpha)).toEqual([
      0.1,
    ]);
    expect(drops(premiumSurface.light.selected).map((l) => l.alpha)).toEqual([
      0.2, 0.26,
    ]);
  });

  it("ramps per state like dark: hover lifts, active collapses, selected is heaviest", () => {
    for (const mode of modes) {
      const rest = drops(premiumSurface[mode].rest).map((l) => l.alpha);
      const hover = drops(premiumSurface[mode].hover).map((l) => l.alpha);
      const active = drops(premiumSurface[mode].active).map((l) => l.alpha);
      const selected = drops(premiumSurface[mode].selected).map((l) => l.alpha);
      expect(rest).toHaveLength(3);
      expect(hover).toHaveLength(3);
      expect(active).toHaveLength(1);
      expect(selected).toHaveLength(2);
      for (let i = 0; i < 3; i++) expect(hover[i]).toBeGreaterThan(rest[i]);
      expect(active[0]).toBeLessThanOrEqual(rest[0]);
      expect(selected[0]).toBeGreaterThan(rest[0]);
      expect(selected[1]).toBeGreaterThan(rest[1]);
    }
  });
});

describe("titleBarShadow", () => {
  it("shares one structure across modes: machined bottom rim + soft drop", () => {
    const light = parseLayers(titleBarShadow.light);
    const dark = parseLayers(titleBarShadow.dark);
    expect(geometry(light)).toEqual(geometry(dark));
    expect(light).toHaveLength(2);
    expect(light[0].inset).toBe(true);
    expect(dark[0].inset).toBe(true);
    expect([light[0].ox, light[0].oy]).toEqual([0, -1]);
  });

  it("casts warm ink in light and neutral black in dark", () => {
    expect(rgb(parseLayers(titleBarShadow.light)[1])).toBe("26, 23, 18");
    expect(rgb(parseLayers(titleBarShadow.dark)[1])).toBe("0, 0, 0");
    expect(parseLayers(titleBarShadow.light)[1].alpha).toBe(0.14);
    expect(parseLayers(titleBarShadow.dark)[1].alpha).toBe(0.35);
  });
});

describe("accentSurface", () => {
  it.each(modes)(
    "%s keeps the emboss and casts the accent as its drop",
    (mode) => {
      const ls = parseLayers(accentSurface[mode]);
      expect(ls).toHaveLength(3);
      expect(ls[0].inset && ls[1].inset).toBe(true);
      expect(ls[2].inset).toBe(false);
    },
  );

  it("uses each scheme's accent", () => {
    expect(accentSurface.light).toContain("27, 138, 248");
    expect(accentSurface.dark).toContain("49, 152, 255");
  });
});

describe("theme.ts consumers", () => {
  it("reference shadow tokens instead of ad-hoc shadow strings", () => {
    const src = readFileSync(new URL("../theme.ts", import.meta.url), "utf8");
    const literalBoxShadows = src.match(/boxShadow:\s*[`"']/g) ?? [];
    expect(literalBoxShadows).toEqual([]);
  });
});
