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
  const sampleX = point[0] * GRAIN_FREQUENCY;
  const sampleY = point[1] * GRAIN_FREQUENCY;
  const sampleZ = point[2] * GRAIN_FREQUENCY;
  const cellX = Math.floor(sampleX);
  const cellY = Math.floor(sampleY);
  const cellZ = Math.floor(sampleZ);
  const blendX = smooth(sampleX - cellX);
  const blendY = smooth(sampleY - cellY);
  const blendZ = smooth(sampleZ - cellZ);
  const plane = (layer: number) =>
    mix(
      mix(
        hash(cellX, cellY, cellZ + layer),
        hash(cellX + 1, cellY, cellZ + layer),
        blendX,
      ),
      mix(
        hash(cellX, cellY + 1, cellZ + layer),
        hash(cellX + 1, cellY + 1, cellZ + layer),
        blendX,
      ),
      blendY,
    );
  return mix(plane(0), plane(1), blendZ);
};

/** Reduce subpixel grain contrast; this is not a full texture filter. */
export const grainStrength = (
  grain: number,
  pixelsPerBaseEdge: number,
): number =>
  grain * Math.min(1, Math.max(0, pixelsPerBaseEdge) / (2 * GRAIN_FREQUENCY));
