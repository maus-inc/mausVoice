import type { Vec3 } from "./keycap3d.geometry";

const GRAIN_FREQUENCY = 140;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (value: number) => value * value * (3 - 2 * value);

const hash = (x: number, y: number, z: number): number => {
  let value =
    Math.imul(x, 374761393) ^
    Math.imul(y, 668265263) ^
    Math.imul(z, 2147483647);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};

/** A deterministic, continuous grain in the cap's own coordinates. */
export const grainAt = (point: Vec3): number => {
  const x = point[0] * GRAIN_FREQUENCY;
  const y = point[1] * GRAIN_FREQUENCY;
  const z = point[2] * GRAIN_FREQUENCY;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const ty = smooth(y - iy);
  const tz = smooth(z - iz);
  const plane = (dz: number) =>
    mix(
      mix(hash(ix, iy, iz + dz), hash(ix + 1, iy, iz + dz), tx),
      mix(hash(ix, iy + 1, iz + dz), hash(ix + 1, iy + 1, iz + dz), tx),
      ty,
    );
  return mix(plane(0), plane(1), tz);
};

/** Reduce subpixel grain contrast; this is not a full texture filter. */
export const grainStrength = (
  grain: number,
  pixelsPerBaseEdge: number,
): number =>
  grain * Math.min(1, Math.max(0, pixelsPerBaseEdge) / (2 * GRAIN_FREQUENCY));
