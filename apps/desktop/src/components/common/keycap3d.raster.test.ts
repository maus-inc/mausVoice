// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { layoutKeycap } from "./keycap3d.geometry";

class TestImageData {
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each(["angle", "front"] as const)(
  "renders the incremental %s fallback with the same pixels as the worker path",
  async (view) => {
    vi.stubGlobal("ImageData", TestImageData);
    const options = {
      layout: layoutKeycap({ size: 45, view }),
      grain: 0.13,
      scale: 2,
    };
    const first = await import("./keycap3d.raster");
    const expected = first.getCapRaster(options);
    vi.resetModules();
    const second = await import("./keycap3d.raster");
    const result = await second.getCapRasterAsync(
      options,
      new AbortController().signal,
    );
    expect(result.width).toBe(expected.width);
    expect(result.height).toBe(expected.height);
    expect(result.data).toEqual(expected.data);
  },
);

it("coalesces local work and allows one consumer to cancel without cancelling another", async () => {
  vi.stubGlobal("ImageData", TestImageData);
  const { getCapRasterAsync } = await import("./keycap3d.raster");
  const options = {
    layout: layoutKeycap({ size: 56, view: "angle" }),
    grain: 0.11,
    scale: 2,
  };
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = getCapRasterAsync(options, first.signal);
  const retained = getCapRasterAsync(options, second.signal);
  const alsoRetained = getCapRasterAsync(options, new AbortController().signal);
  first.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  const [image, sameImage] = await Promise.all([retained, alsoRetained]);
  expect(image).toMatchObject({ width: expect.any(Number) });
  expect(image).toBe(sameImage);
});

it("cancels abandoned local work before it starts and allows a new request", async () => {
  vi.stubGlobal("ImageData", TestImageData);
  const { getCapRasterAsync } = await import("./keycap3d.raster");
  const options = {
    layout: layoutKeycap({ size: 53, view: "front" }),
    grain: 0.17,
    scale: 1,
  };
  const controller = new AbortController();
  const cancelled = getCapRasterAsync(options, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  await expect(
    getCapRasterAsync(options, new AbortController().signal),
  ).resolves.toMatchObject({ width: expect.any(Number) });
});

it("yields between rows instead of finishing a whole raster in one task", async () => {
  vi.stubGlobal("ImageData", TestImageData);
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 9));
  try {
    const { getCapRasterAsync } = await import("./keycap3d.raster");
    const options = {
      layout: layoutKeycap({ size: 25, view: "front" }),
      grain: 0.12,
      scale: 1,
    };
    let completed = false;
    const result = getCapRasterAsync(
      options,
      new AbortController().signal,
    ).then(() => {
      completed = true;
    });
    await vi.runOnlyPendingTimersAsync();
    expect(completed).toBe(false);
    await vi.runAllTimersAsync();
    await result;
    expect(completed).toBe(true);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("defers local allocation and cancels before allocating abandoned work", async () => {
  const allocate = vi.fn(function (width: number, height: number) {
    return new TestImageData(width, height);
  });
  vi.stubGlobal("ImageData", allocate);
  vi.useFakeTimers();
  try {
    const { getCapRasterAsync } = await import("./keycap3d.raster");
    const options = {
      layout: layoutKeycap({ size: 29, view: "front" }),
      grain: 0.17,
      scale: 1,
    };
    const controller = new AbortController();
    const cancelled = getCapRasterAsync(options, controller.signal);
    expect(allocate).not.toHaveBeenCalled();
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await vi.runAllTimersAsync();
    expect(allocate).not.toHaveBeenCalled();
    const retained = getCapRasterAsync(options, new AbortController().signal);
    expect(allocate).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await expect(retained).resolves.toMatchObject({
      width: expect.any(Number),
    });
    expect(allocate).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("bounds the completed cache and retains recently used rasters", async () => {
  vi.stubGlobal("ImageData", TestImageData);
  const { getCapRaster, getCachedCapRaster } =
    await import("./keycap3d.raster");
  const options = {
    layout: layoutKeycap({ size: 4, view: "front" }),
    grain: 0,
    scale: 1,
  };
  const first = getCapRaster(options);
  for (let grain = 1; grain < 8; grain += 1) {
    getCapRaster({ ...options, grain });
  }
  expect(getCachedCapRaster(options)).toBe(first);
  getCapRaster({ ...options, grain: 8 });
  expect(getCachedCapRaster({ ...options, grain: 1 })).toBeUndefined();
  expect(getCachedCapRaster(options)).toBe(first);
});

it("uses the display scale without exceeding the raster budget", async () => {
  const { capRasterOptions } = await import("./keycap3d.raster");
  const small = layoutKeycap({ size: 34, view: "front" });
  const large = layoutKeycap({ size: 250, view: "angle" });
  for (const dpr of [0, 0.5, 1, 1.25, 2, 3]) {
    expect(capRasterOptions(small, 0.2, dpr).scale).toBe(Math.max(1, dpr));
  }
  const { scale } = capRasterOptions(large, 0.2, 3);
  expect(Math.ceil(Math.max(large.width, large.height) * scale)).toBe(420);
});

it("propagates local allocation failures and allows a retry", async () => {
  vi.stubGlobal(
    "ImageData",
    vi.fn().mockImplementation(() => {
      throw new Error("allocation failed");
    }),
  );
  const { getCapRasterAsync } = await import("./keycap3d.raster");
  const options = {
    layout: layoutKeycap({ size: 39, view: "front" }),
    grain: 0.1,
    scale: 1,
  };
  await expect(
    getCapRasterAsync(options, new AbortController().signal),
  ).rejects.toThrow("allocation failed");
  vi.stubGlobal("ImageData", TestImageData);
  await expect(
    getCapRasterAsync(options, new AbortController().signal),
  ).resolves.toMatchObject({ width: expect.any(Number) });
});
