import {
  compactIntersectionPlanes,
  createPixelRayFactory,
  createKeycapIntersector,
  createKeycapNormalSampler,
  intersectKeycap,
  keycapPlanes,
  layoutKeycap,
  occlusionAt,
  plasticAt,
  shadeKeycap,
} from "./keycap3d.geometry";
import { grainAt, grainStrength } from "./keycap3d.texture";

const MAX_CACHED_RASTERS = 8;
const rasterCache = new Map<string, ImageData>();

export type RasterOptions = {
  layout: ReturnType<typeof layoutKeycap>;
  grain: number;
  scale: number;
};

/**
 * Paint the cap into an `ImageData`.
 *
 * Rays intersect the cap's planes; blended normals provide the shading.
 * Silhouette pixels receive additional coverage samples.
 */
const rasteriseCap = ({ layout, grain, scale }: RasterOptions): ImageData => {
  const { originX, originY, scalePx, camera, ratios } = layout;
  const planes = keycapPlanes(ratios);
  const intersectionPlanes = compactIntersectionPlanes(planes);
  const rayAt = createPixelRayFactory(originX, originY, scalePx, camera);
  const intersectFromCamera =
    camera.perspective === null || camera.perspective === 0
      ? undefined
      : createKeycapIntersector(intersectionPlanes, rayAt(0, 0).origin);
  // How far the crease softens, in base edges. Small on purpose: the cap's
  // faces stay flat and the rounding only shows up as a band a few pixels wide,
  // which is what the reference render has.
  const roll = Math.max(ratios.radius * 0.12, 0.008);
  const normalAt = createKeycapNormalSampler(intersectionPlanes, roll, ratios);
  const image = new ImageData(
    Math.max(1, Math.ceil(layout.width * scale)),
    Math.max(1, Math.ceil(layout.height * scale)),
  );
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);
  const textureStrength = grainStrength(grain, scalePx * scale);
  const sample = (x: number, y: number) => {
    const ray = rayAt(x / scale, y / scale);
    const hit = intersectFromCamera
      ? intersectFromCamera(ray.direction)
      : intersectKeycap(ray.origin, ray.direction, intersectionPlanes);
    if (hit === null) return null;
    const normal = normalAt(hit.point);
    // Pixel rays are unit length, so the surface-to-camera direction is their
    // inverse. No per-hit subtraction or second normalization is needed.
    const view: [number, number, number] = [
      -ray.direction[0],
      -ray.direction[1],
      -ray.direction[2],
    ];
    const shade = shadeKeycap(
      normal,
      view,
      occlusionAt(hit.point[2], ratios.height),
      hit.point,
    );
    return plasticAt(
      shade,
      textureStrength,
      textureStrength === 0 ? 0.5 : grainAt(hit.point),
    );
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = sample(x + 0.5, y + 0.5);
      if (colour === null) continue;
      const pixel = y * width + x;
      mask[pixel] = 1;
      const offset = pixel * 4;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = 255;
    }
  }

  // Only silhouette pixels need extra samples. The centre pass supplies a
  // stable mask, including empty pixels adjacent to the cap.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const inside = mask[pixel];
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          const neighbour =
            nx < 0 || ny < 0 || nx >= width || ny >= height
              ? 0
              : mask[ny * width + nx];
          if (neighbour !== inside) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) continue;
      let coverage = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const sy of [0.25, 0.75]) {
        for (const sx of [0.25, 0.75]) {
          const colour = sample(x + sx, y + sy);
          if (colour === null) continue;
          coverage += 1;
          r += colour[0];
          g += colour[1];
          b += colour[2];
        }
      }
      const offset = pixel * 4;
      data[offset] = coverage ? r / coverage : 0;
      data[offset + 1] = coverage ? g / coverage : 0;
      data[offset + 2] = coverage ? b / coverage : 0;
      data[offset + 3] = (coverage / 4) * 255;
    }
  }
  return image;
};

export const rasterCacheKey = ({
  layout,
  grain,
  scale,
}: RasterOptions): string => {
  const { camera, ratios } = layout;
  return JSON.stringify([
    layout.scalePx,
    camera.tilt,
    camera.spin,
    camera.roll,
    camera.perspective,
    ratios.height,
    ratios.face,
    ratios.radius,
    ratios.faceTilt,
    ratios.dish,
    grain,
    scale,
  ]);
};

export const getCapRaster = (options: RasterOptions): ImageData => {
  const key = rasterCacheKey(options);
  const cached = rasterCache.get(key);
  if (cached) {
    rasterCache.delete(key);
    rasterCache.set(key, cached);
    return cached;
  }
  const image = rasteriseCap(options);
  rasterCache.set(key, image);
  if (rasterCache.size > MAX_CACHED_RASTERS) {
    const oldest = rasterCache.keys().next().value;
    if (oldest !== undefined) rasterCache.delete(oldest);
  }
  return image;
};
