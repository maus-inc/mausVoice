import { rasterCacheKey, type RasterOptions } from "./keycap3d.raster";

type Pending = {
  id: number;
  key: string;
  options: RasterOptions;
  promise: Promise<ImageData>;
  resolve: (image: ImageData) => void;
  reject: (error: Error) => void;
  consumers: number;
};

let worker: Worker | null | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let active: Pending | undefined;
let nextId = 0;
const queue: Pending[] = [];
const byKey = new Map<string, Pending>();
const byPromise = new Map<Promise<ImageData>, Pending>();

const forget = (request: Pending) => {
  if (byKey.get(request.key) === request) byKey.delete(request.key);
  byPromise.delete(request.promise);
};

const disableWorker = (reason: string) => {
  worker?.terminate();
  worker = null;
  clearTimeout(watchdog);
  watchdog = undefined;
  const requests = active ? [active, ...queue] : [...queue];
  active = undefined;
  queue.length = 0;
  for (const request of requests) {
    forget(request);
    request.reject(new Error(reason));
  }
};

const dispatch = () => {
  if (!worker || active || queue.length === 0) return;
  const request = queue.shift()!;
  active = request;
  watchdog = setTimeout(() => disableWorker("Keycap worker timed out"), 10000);
  try {
    worker.postMessage({ id: request.id, options: request.options });
  } catch {
    disableWorker("Keycap worker could not accept a request");
  }
};

const getWorker = (): Worker | null => {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    worker = new Worker(new URL("./keycap3d.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; image?: ImageData; error?: string }>) => {
      const request = active;
      if (request?.id === undefined || request.id !== data.id) return;
      clearTimeout(watchdog);
      watchdog = undefined;
      active = undefined;
      forget(request);
      if (data.image) request.resolve(data.image);
      else request.reject(new Error(data.error ?? "Worker returned no image"));
      dispatch();
    };
    worker.onerror = () => disableWorker("Keycap worker failed");
    worker.onmessageerror = () => disableWorker("Keycap worker message failed");
    return worker;
  } catch {
    worker = null;
    return null;
  }
};

/** Returns null when workers are unavailable; rejected requests can fall back locally. */
export const requestCapRaster = (
  options: RasterOptions,
): Promise<ImageData> | null => {
  if (!getWorker()) return null;
  const key = rasterCacheKey(options);
  const existing = byKey.get(key);
  if (existing) {
    existing.consumers += 1;
    return existing.promise;
  }
  let resolve!: (image: ImageData) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ImageData>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const request = {
    id: nextId++,
    key,
    options,
    promise,
    resolve,
    reject,
    consumers: 1,
  };
  byKey.set(key, request);
  byPromise.set(promise, request);
  queue.push(request);
  dispatch();
  return promise;
};

/** Release one consumer. Queued work with no remaining consumers is discarded. */
export const releaseCapRaster = (promise: Promise<ImageData>): void => {
  const request = byPromise.get(promise);
  if (!request) return;
  request.consumers -= 1;
  if (request.consumers > 0 || request === active) return;
  const index = queue.indexOf(request);
  if (index !== -1) queue.splice(index, 1);
  forget(request);
  request.reject(new Error("Keycap raster request cancelled"));
};
