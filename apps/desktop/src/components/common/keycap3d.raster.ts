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

type PixelSampler = (x: number, y: number) => [number, number, number] | null;

const fillCentrePixels = (
  image: ImageData,
  mask: Uint8Array,
  sample: PixelSampler,
  start: number,
  end: number,
) => {
  const { data, width } = image;
  for (let y = start; y < end; y += 1) {
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
};

const maskAt = (
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]);

const isSilhouetteEdge = (
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean => {
  const inside = mask[y * width + x];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (maskAt(mask, width, height, x + dx, y + dy) !== inside) return true;
    }
  }
  return false;
};

const fillEdgePixel = (
  data: Uint8ClampedArray,
  offset: number,
  x: number,
  y: number,
  sample: PixelSampler,
) => {
  let coverage = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const sy of [0.25, 0.75]) {
    for (const sx of [0.25, 0.75]) {
      const colour = sample(x + sx, y + sy);
      if (colour === null) continue;
      coverage += 1;
      red += colour[0];
      green += colour[1];
      blue += colour[2];
    }
  }
  if (coverage === 0) {
    data.fill(0, offset, offset + 4);
    return;
  }
  data[offset] = red / coverage;
  data[offset + 1] = green / coverage;
  data[offset + 2] = blue / coverage;
  data[offset + 3] = (coverage / 4) * 255;
};

const fillSilhouette = (
  image: ImageData,
  mask: Uint8Array,
  sample: PixelSampler,
  start: number,
  end: number,
) => {
  const { data, width, height } = image;
  for (let y = start; y < end; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isSilhouetteEdge(mask, width, height, x, y)) {
        fillEdgePixel(data, (y * width + x) * 4, x, y, sample);
      }
    }
  }
};

/**
 * Paint the cap into an `ImageData`.
 *
 * Rays intersect the cap's planes; blended normals provide the shading.
 * Silhouette pixels receive additional coverage samples.
 */
const createRaster = ({ layout, grain, scale }: RasterOptions) => {
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
  const mask = new Uint8Array(image.width * image.height);
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

  return { image, mask, sample };
};

const rasteriseCap = (options: RasterOptions): ImageData => {
  const { image, mask, sample } = createRaster(options);
  fillCentrePixels(image, mask, sample, 0, image.height);
  fillSilhouette(image, mask, sample, 0, image.height);
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

const cachedRaster = (key: string): ImageData | undefined => {
  const cached = rasterCache.get(key);
  if (cached) {
    rasterCache.delete(key);
    rasterCache.set(key, cached);
  }
  return cached;
};

const cacheRaster = (key: string, image: ImageData): ImageData => {
  rasterCache.set(key, image);
  if (rasterCache.size > MAX_CACHED_RASTERS) {
    const oldest = rasterCache.keys().next().value;
    if (oldest !== undefined) rasterCache.delete(oldest);
  }
  return image;
};

export const getCapRaster = (options: RasterOptions): ImageData => {
  const key = rasterCacheKey(options);
  return cachedRaster(key) ?? cacheRaster(key, rasteriseCap(options));
};

/** Yield between rows when no worker is available so input and paint can proceed. */
const rasteriseCapIncrementally = (
  key: string,
  options: RasterOptions,
  signal: AbortSignal,
): Promise<ImageData> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Keycap raster request cancelled"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new Error("Keycap raster request cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    let raster: ReturnType<typeof createRaster>;
    try {
      raster = createRaster(options);
    } catch (error) {
      signal.removeEventListener("abort", cancel);
      reject(error);
      return;
    }
    const { image, mask, sample } = raster;
    let row = 0;
    const step = () => {
      try {
        const deadline = performance.now() + 8;
        do {
          if (row < image.height) {
            fillCentrePixels(image, mask, sample, row, row + 1);
          } else {
            const edgeRow = row - image.height;
            fillSilhouette(image, mask, sample, edgeRow, edgeRow + 1);
          }
          row += 1;
          if (row === image.height * 2) {
            signal.removeEventListener("abort", cancel);
            resolve(cacheRaster(key, image));
            return;
          }
        } while (performance.now() < deadline);
        timer = setTimeout(step, 0);
      } catch (error) {
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    };
    timer = setTimeout(step, 0);
  });

type PendingLocalRaster = {
  controller: AbortController;
  promise: Promise<ImageData>;
  consumers: number;
};
const pendingLocalRasters = new Map<string, PendingLocalRaster>();

export const getCapRasterAsync = (
  options: RasterOptions,
  signal: AbortSignal,
): Promise<ImageData> => {
  if (signal.aborted)
    return Promise.reject(new Error("Keycap raster request cancelled"));
  const key = rasterCacheKey(options);
  const cached = cachedRaster(key);
  if (cached) return Promise.resolve(cached);
  let pending = pendingLocalRasters.get(key);
  if (!pending) {
    const controller = new AbortController();
    const promise = rasteriseCapIncrementally(key, options, controller.signal);
    pending = { controller, promise, consumers: 0 };
    const request = pending;
    pendingLocalRasters.set(key, request);
    promise.then(
      () => {
        if (pendingLocalRasters.get(key) === request)
          pendingLocalRasters.delete(key);
      },
      () => {
        if (pendingLocalRasters.get(key) === request)
          pendingLocalRasters.delete(key);
      },
    );
  }
  const request = pending;
  request.consumers += 1;
  return new Promise((resolve, reject) => {
    let active = true;
    const release = () => {
      if (!active) return false;
      active = false;
      signal.removeEventListener("abort", cancel);
      request.consumers -= 1;
      return true;
    };
    function cancel() {
      if (!release()) return;
      if (request.consumers === 0) {
        if (pendingLocalRasters.get(key) === request)
          pendingLocalRasters.delete(key);
        request.controller.abort();
      }
      reject(new Error("Keycap raster request cancelled"));
    }
    signal.addEventListener("abort", cancel, { once: true });
    request.promise.then(
      (image) => {
        if (release()) resolve(image);
      },
      (error) => {
        if (release()) reject(error);
      },
    );
  });
};
