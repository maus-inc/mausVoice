import { describe, expect, it } from "vitest";
import { grainAt, grainStrength } from "./keycap3d.texture";

describe("keycap surface grain", () => {
  it("returns deterministic bounded values at different object-space points", () => {
    const points = [
      [0.01, 0.04, 0.235],
      [-0.1, 0.2, -0.235],
      [0.5, -0.5, 0],
    ] as const;
    const values = points.map(grainAt);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(points.map(grainAt)).toEqual(values);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("is continuous across a texture cell boundary", () => {
    const boundary = 10 / 140;
    expect(
      Math.abs(
        grainAt([boundary - 0.000001, 0.0123, 0.235]) -
          grainAt([boundary + 0.000001, 0.0123, 0.235]),
      ),
    ).toBeLessThan(0.001);
  });

  it("reduces texture contrast at low raster resolutions", () => {
    expect(grainStrength(0.2, 0)).toBe(0);
    expect(grainStrength(0.2, 70)).toBeCloseTo(0.05);
    expect(grainStrength(0.2, 280)).toBeCloseTo(0.2);
    expect(grainStrength(0.2, 560)).toBeCloseTo(0.2);
    expect(grainStrength(0, 560)).toBe(0);
  });
});
