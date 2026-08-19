import type { Theme } from "@mui/material/styles";
import { describe, expect, it } from "vitest";
import { theme } from "../theme";
import {
  accentSurface,
  parseShadowLayers,
  premiumSurface,
  titleBarShadow,
  type ShadowLayer,
} from "./shadows";

/**
 * Contract tests for the layered-surface shadow language (DESIGN.md:
 * "premiumSurface = 2px inner top highlight (emboss) + multi-stop soft drop
 * shadow").
 *
 * The language is pinned in two layers:
 * - structural invariants (shared geometry across modes, scheme ink tinting,
 *   the rest/hover/active/selected ramp) — these are the design and must not
 *   change with tuning;
 * - the named tuning tables below, one per owner, so iterative visual tuning
 *   edits a single table instead of scattered literals (A14: light emboss,
 *   A16: mirrored light drops).
 *
 * Tokens are parsed with shadows.ts's own `parseShadowLayers` rather than a
 * test-local regex, so a change to the token syntax fails loudly here with
 * the offending token instead of silently breaking assertions.
 */

// ---- Pinned tuning values (edit these tables when tuning, not the tests) ----

/** A14's light-mode emboss and the dark reference emboss; active = [press, rim]. */
const embossAlphas = {
  light: {
    rest: [0.42, 0.14],
    hover: [0.58, 0.2],
    active: [0.07, 0.18],
    selected: [0.18, 0.06],
  },
  dark: {
    rest: [0.08, 0.03],
    hover: [0.12, 0.05],
    active: [0.45, 0.04],
    selected: [0.14, 0.05],
  },
} as const;

/** Drop alphas per state; light mirrors dark's stop geometry (A16). */
const dropAlphas = {
  light: {
    rest: [0.1, 0.12, 0.1],
    hover: [0.12, 0.16, 0.13],
    active: [0.1],
    selected: [0.2, 0.26],
  },
  dark: {
    rest: [0.35, 0.35, 0.28],
    hover: [0.4, 0.42, 0.35],
    active: [0.35],
    selected: [0.4, 0.45],
  },
} as const;

/** Title bar: [bottom rim, drop]. */
const titleBarAlphas = {
  light: [0.3, 0.14],
  dark: [0.04, 0.35],
} as const;

/** Accent CTA: [1px rim, 2px halo, accent drop]. */
const accentAlphas = {
  light: [0.28, 0.1, 0.35],
  dark: [0.28, 0.1, 0.35],
} as const;

const modes = ["light", "dark"] as const;
const states = ["rest", "hover", "active", "selected"] as const;

const insets = (token: string) =>
  parseShadowLayers(token).filter((layer) => layer.inset);
const drops = (token: string) =>
  parseShadowLayers(token).filter((layer) => !layer.inset);
const alphas = (layers: ShadowLayer[]) => layers.map((layer) => layer.alpha);
const geometry = (layers: ShadowLayer[]) =>
  layers.map(({ offsetX, offsetY, blur }) => [offsetX, offsetY, blur]);
const rgb = (layer: ShadowLayer) => `${layer.r}, ${layer.g}, ${layer.b}`;

describe("premiumSurface: one language, two modes", () => {
  it.each(states)(
    "%s has the same emboss rows and drop stops in both modes",
    (state) => {
      const light = parseShadowLayers(premiumSurface.light[state]);
      const dark = parseShadowLayers(premiumSurface.dark[state]);
      // Layer order is stable: emboss insets first, drops after.
      expect(light.map((layer) => layer.inset)).toEqual(
        dark.map((layer) => layer.inset),
      );
      // Emboss rows: 1px crisp rim + 2px halo, always from the top. Active
      // leads with the press inset instead, so the rim is second there.
      for (const mode of modes) {
        const ls = insets(premiumSurface[mode][state]);
        const rim = ls[state === "active" ? 1 : 0];
        const other = ls[state === "active" ? 0 : 1];
        expect([rim.offsetX, rim.offsetY, rim.blur]).toEqual([0, 1, 0]);
        expect([other.offsetX, other.offsetY]).toEqual([0, 2]);
      }
      // Drop stops mirror each other exactly (A16).
      expect(geometry(drops(premiumSurface.light[state]))).toEqual(
        geometry(drops(premiumSurface.dark[state])),
      );
    },
  );

  it("pins the tuned alphas per state and mode", () => {
    for (const mode of modes) {
      for (const state of states) {
        expect(alphas(insets(premiumSurface[mode][state]))).toEqual(
          embossAlphas[mode][state],
        );
        expect(alphas(drops(premiumSurface[mode][state]))).toEqual(
          dropAlphas[mode][state],
        );
      }
    }
  });

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
        const ls = insets(premiumSurface[mode][state]);
        expect(rgb(ls[state === "active" ? 1 : 0])).toBe("255, 255, 255");
      }
    }
    expect(rgb(insets(premiumSurface.light.active)[0])).toBe("26, 23, 18");
    expect(rgb(insets(premiumSurface.dark.active)[0])).toBe("0, 0, 0");
  });

  it("ramps per state like dark: hover lifts, active collapses, selected is heaviest", () => {
    for (const mode of modes) {
      const rest = alphas(drops(premiumSurface[mode].rest));
      const hover = alphas(drops(premiumSurface[mode].hover));
      const active = alphas(drops(premiumSurface[mode].active));
      const selected = alphas(drops(premiumSurface[mode].selected));
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
    const light = parseShadowLayers(titleBarShadow.light);
    const dark = parseShadowLayers(titleBarShadow.dark);
    expect(geometry(light)).toEqual(geometry(dark));
    expect(light.map((layer) => layer.inset)).toEqual([true, false]);
    expect([light[0].offsetX, light[0].offsetY]).toEqual([0, -1]);
  });

  it("pins the tuned alphas and casts the scheme ink", () => {
    for (const mode of modes) {
      expect(alphas(parseShadowLayers(titleBarShadow[mode]))).toEqual(
        titleBarAlphas[mode],
      );
    }
    expect(rgb(parseShadowLayers(titleBarShadow.light)[1])).toBe("26, 23, 18");
    expect(rgb(parseShadowLayers(titleBarShadow.dark)[1])).toBe("0, 0, 0");
  });
});

describe("accentSurface", () => {
  it.each(modes)(
    "%s keeps the emboss and casts the accent as its drop",
    (mode) => {
      const layers = parseShadowLayers(accentSurface[mode]);
      expect(alphas(layers)).toEqual(accentAlphas[mode]);
      expect(layers.map((layer) => layer.inset)).toEqual([true, true, false]);
      expect(rgb(layers[2])).toBe(
        mode === "light" ? "27, 138, 248" : "49, 152, 255",
      );
    },
  );
});

describe("parseShadowLayers", () => {
  it("rejects token syntax it cannot fully parse instead of dropping layers", () => {
    expect(() => parseShadowLayers("0 1px 2px rgb(0, 0, 0)")).toThrow(
      /Unsupported shadow token format/,
    );
    expect(() => parseShadowLayers("0 1px 2px #000000")).toThrow(
      /Unsupported shadow token format/,
    );
    expect(() => parseShadowLayers("0 1px 2px var(--shadow-ink)")).toThrow(
      /Unsupported shadow token format/,
    );
  });
});

/**
 * Walks the resolved component styles of the theme and collects every
 * box-shadow value. Style callbacks are invoked with the real theme the way
 * MUI does; MuiCssBaseline's override takes the raw theme rather than
 * `{ theme }`, hence the fallback.
 */
const collectBoxShadows = (style: unknown, out: Set<string>): void => {
  if (style == null) return;
  if (typeof style === "function") {
    let resolved: unknown;
    try {
      resolved = (style as (args: { theme: Theme }) => unknown)({ theme });
    } catch {
      resolved = (style as (rawTheme: Theme) => unknown)(theme);
    }
    collectBoxShadows(resolved, out);
    return;
  }
  if (Array.isArray(style)) {
    style.forEach((entry) => collectBoxShadows(entry, out));
    return;
  }
  if (typeof style !== "object") return;
  const record = style as Record<string, unknown>;
  if (typeof record.boxShadow === "string") out.add(record.boxShadow);
  Object.values(record).forEach((value) => collectBoxShadows(value, out));
};

describe("theme.ts consumers", () => {
  it("resolves every box-shadow in the theme to a shadows.ts token", () => {
    const tokenValues = new Set<string>([
      ...Object.values(premiumSurface.light),
      ...Object.values(premiumSurface.dark),
      accentSurface.light,
      accentSurface.dark,
      ...Object.values(titleBarShadow),
      "none",
    ]);
    const found = new Set<string>();
    for (const component of Object.values(theme.components ?? {})) {
      collectBoxShadows(component, found);
    }
    // Guard that the walk actually found shadows — otherwise this test
    // would pass vacuously.
    expect(found.size).toBeGreaterThan(0);
    for (const value of found) {
      expect(
        tokenValues.has(value),
        `ad-hoc shadow in theme.ts: ${value}`,
      ).toBe(true);
    }
  });
});
