import { describe, expect, it } from "vitest";
import { Perlin } from "./math.utils";

describe("Perlin noise", () => {
  it("returns zero at lattice points and deterministic values between them", () => {
    const first = new Perlin();
    const second = new Perlin();
    expect(first.noise(0, 0, 0)).toBe(0);
    expect(first.noise(-1, 2, 3)).toBe(0);
    const value = first.noise(0.1, 0.2, 0.3);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).not.toBe(0);
    expect(second.noise(0.1, 0.2, 0.3)).toBe(value);
  });

  it("repeats after 256 cells and remains continuous across lattice boundaries", () => {
    const noise = new Perlin();
    const value = noise.noise(-0.25, 1.5, 2.75);
    expect(noise.noise(255.75, 1.5, 2.75)).toBeCloseTo(value, 12);
    expect(noise.noise(-0.25, 257.5, 2.75)).toBeCloseTo(value, 12);
    expect(noise.noise(-0.25, 1.5, 258.75)).toBeCloseTo(value, 12);
    const left = noise.noise(1 - 1e-6, 0.37, -0.4);
    const right = noise.noise(1 + 1e-6, 0.37, -0.4);
    expect(Math.abs(left - right)).toBeLessThan(1e-4);
  });
});
