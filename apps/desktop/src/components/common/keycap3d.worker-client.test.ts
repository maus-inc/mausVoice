// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { layoutKeycap } from "./keycap3d.geometry";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((_message: unknown) => {});
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
}
const options = {
  layout: layoutKeycap({ size: 34, view: "front" }),
  grain: 0,
  scale: 1,
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("ignores a reply for a request that has not started", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const worker = FakeWorker.instances[0];
  const a = { width: 1 } as ImageData;
  const b = { width: 2 } as ImageData;
  worker.onmessage?.({ data: { id: 1, image: b } } as MessageEvent);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.onmessage?.({ data: { id: 0, image: a } } as MessageEvent);
  expect(await first).toBe(a);
  worker.onmessage?.({ data: { id: 1, image: b } } as MessageEvent);
  expect(await second).toBe(b);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("drops unused queued rasters instead of rendering stale requests", async () => {
  const { requestCapRaster, releaseCapRaster } =
    await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const stale = requestCapRaster({ ...options, grain: 0.1 })!;
  const staleResult = Promise.allSettled([stale]);
  const latest = requestCapRaster({ ...options, grain: 0.2 })!;
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  releaseCapRaster(stale);
  expect((await staleResult)[0].status).toBe("rejected");
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  expect(await first).toBe(image);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const sent = worker.postMessage.mock.calls[1][0] as {
    id: number;
    options: typeof options;
  };
  expect(sent.options.grain).toBe(0.2);
  worker.onmessage?.({ data: { id: sent.id, image } } as MessageEvent);
  expect(await latest).toBe(image);
});

it("coalesces identical pending rasters", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const second = requestCapRaster({ ...options })!;
  expect(second).toBe(first);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  expect(await first).toBe(image);
});

it("retains shared queued work until the last consumer releases it", async () => {
  const { requestCapRaster, releaseCapRaster } =
    await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const shared = requestCapRaster({ ...options, grain: 0.1 })!;
  const other = requestCapRaster({ ...options, grain: 0.1 })!;
  expect(shared).toBe(other);
  releaseCapRaster(shared);
  const worker = FakeWorker.instances[0];
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  expect(await first).toBe(image);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.onmessage?.({ data: { id: 1, image } } as MessageEvent);
  expect(await other).toBe(image);
});

it("can request a discarded raster again before rejection handlers run", async () => {
  const { requestCapRaster, releaseCapRaster } =
    await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const old = requestCapRaster({ ...options, grain: 0.1 })!;
  const oldResult = Promise.allSettled([old]);
  releaseCapRaster(old);
  const fresh = requestCapRaster({ ...options, grain: 0.1 })!;
  expect(fresh).not.toBe(old);
  expect((await oldResult)[0].status).toBe("rejected");
  const worker = FakeWorker.instances[0];
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  await first;
  worker.onmessage?.({ data: { id: 2, image } } as MessageEvent);
  expect(await fresh).toBe(image);
});

it("lets a new consumer reuse an active request after the first releases it", async () => {
  const { requestCapRaster, releaseCapRaster } =
    await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  releaseCapRaster(first);
  const next = requestCapRaster(options)!;
  expect(next).toBe(first);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  expect(await next).toBe(image);
});

it("moves on to queued work after an individual raster error", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const result = Promise.allSettled([first]);
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const worker = FakeWorker.instances[0];
  worker.onmessage?.({ data: { id: 0, error: "bad raster" } } as MessageEvent);
  expect((await result)[0].status).toBe("rejected");
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 1, image } } as MessageEvent);
  expect(await second).toBe(image);
});

it("rejects all pending requests and disables the worker after an error", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const errors = Promise.allSettled([first, second]);
  const worker = FakeWorker.instances[0];
  worker.onerror?.();
  expect((await errors).map((item) => item.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(requestCapRaster(options)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("disables the worker when posting a queued request fails", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const secondResult = Promise.allSettled([second]);
  const worker = FakeWorker.instances[0];
  worker.postMessage.mockImplementationOnce(() => {
    throw new Error("cannot clone");
  });
  const image = { width: 1 } as ImageData;
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  expect(await first).toBe(image);
  expect((await secondResult)[0].status).toBe("rejected");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(requestCapRaster(options)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps queued requests alive while the worker makes progress", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const third = requestCapRaster({ ...options, grain: 0.2 })!;
  const results = Promise.allSettled([first, second, third]);
  const worker = FakeWorker.instances[0];
  const image = { width: 1 } as ImageData;
  vi.advanceTimersByTime(9000);
  worker.onmessage?.({ data: { id: 0, image } } as MessageEvent);
  vi.advanceTimersByTime(9000);
  worker.onmessage?.({ data: { id: 1, image } } as MessageEvent);
  vi.advanceTimersByTime(9000);
  worker.onmessage?.({ data: { id: 2, image } } as MessageEvent);
  expect((await results).map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("disables a worker that stops responding", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const request = requestCapRaster(options)!;
  const result = Promise.allSettled([request]);
  vi.advanceTimersByTime(10000);
  expect((await result)[0].status).toBe("rejected");
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  expect(requestCapRaster(options)).toBeNull();
});

it("does not postpone a stalled worker timeout when new requests arrive", async () => {
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  const first = requestCapRaster(options)!;
  const worker = FakeWorker.instances[0];
  vi.advanceTimersByTime(9000);
  const second = requestCapRaster({ ...options, grain: 0.1 })!;
  const results = Promise.allSettled([first, second]);
  vi.advanceTimersByTime(1000);
  expect((await results).map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("returns null if worker construction is blocked", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("blocked");
      }
    },
  );
  const { requestCapRaster } = await import("./keycap3d.worker-client");
  expect(requestCapRaster(options)).toBeNull();
});
