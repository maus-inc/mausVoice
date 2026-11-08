import { expect, it, vi } from "vitest";
import { TranscriptionAudioCache } from "./transcription-audio-cache";
const audio = { samples: [0, 0], sampleRate: 16000 };
it("deduplicates pending and warm loads", async () => {
  const cache = new TranscriptionAudioCache();
  const load = vi.fn(async () => audio);
  const first = cache.load("a", load);
  expect(cache.load("a", load)).toBe(first);
  await first;
  expect(await cache.load("a", load)).toBe(audio);
  expect(load).toHaveBeenCalledTimes(1);
});
it("does not resurrect a deleted or cleared pending clip", async () => {
  const cache = new TranscriptionAudioCache();
  const first = cache.load("a", async () => audio);
  cache.invalidate();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(await cache.load("a", async () => audio)).toBe(audio);
});
it("evicts least recently used samples by byte budget", async () => {
  const cache = new TranscriptionAudioCache(32);
  const load = vi.fn(async () => audio);
  await cache.load("a", load);
  await cache.load("b", load);
  await cache.load("a", load);
  await cache.load("c", load);
  await cache.load("a", load);
  expect(load).toHaveBeenCalledTimes(3);
  await cache.load("b", load);
  expect(load).toHaveBeenCalledTimes(4);
});
it("expires samples and retries failed loads", async () => {
  let now = 0;
  const cache = new TranscriptionAudioCache(32, () => now);
  const load = vi.fn(async () => audio);
  await cache.load("a", load);
  now = 60_000;
  await cache.load("a", load);
  expect(load).toHaveBeenCalledTimes(2);
  await expect(
    cache.load("b", async () => {
      throw new Error("missing");
    }),
  ).rejects.toThrow("missing");
  expect(await cache.load("b", load)).toBe(audio);
});
it("rejects corrupt data and bounds speculative concurrent loads", async () => {
  const cache = new TranscriptionAudioCache();
  await expect(
    cache.load("bad", async () => ({ ...audio, samples: [NaN] })),
  ).rejects.toThrow("Invalid audio");
  const a = cache.load("a", async () => audio);
  const b = cache.load("b", async () => audio);
  expect(cache.canWarm()).toBe(false);
  await Promise.all([a, b]);
  expect(cache.canWarm()).toBe(true);
});
it("does not evict small clips just to retain an oversized clip", async () => {
  const cache = new TranscriptionAudioCache(16);
  const load = vi.fn(async () => audio);
  await cache.load("small", load);
  const large = vi.fn(async () => ({ ...audio, samples: [0, 0, 0] }));
  await cache.load("large", large);
  await cache.load("small", load);
  expect(load).toHaveBeenCalledOnce();
  await cache.load("large", large);
  expect(large).toHaveBeenCalledTimes(2);
});
it("a superseded failure cannot remove its successor", async () => {
  const cache = new TranscriptionAudioCache();
  const old = cache.load("a", async () => audio);
  cache.invalidate("a");
  const load = vi.fn(async () => audio);
  const next = cache.load("a", load);
  await expect(old).rejects.toMatchObject({ name: "AbortError" });
  await next;
  await cache.load("a", load);
  expect(load).toHaveBeenCalledOnce();
});
it.each([undefined, "a"])(
  "keeps invalidated reads in the concurrency budget when invalidating %s",
  async (id) => {
    const cache = new TranscriptionAudioCache();
    let finish!: (value: typeof audio) => void;
    const reading = new Promise<typeof audio>((resolve) => {
      finish = resolve;
    });
    const a = cache.load("a", () => reading);
    const b = cache.load("b", () => reading);
    const settled = Promise.allSettled([a, b]);
    await Promise.resolve();
    try {
      cache.invalidate(id);
      expect(cache.canWarm()).toBe(false);
    } finally {
      finish(audio);
      await settled;
    }
    expect(cache.canWarm()).toBe(true);
  },
);
it("counts shared loads once and releases slots after synchronous failure", async () => {
  const cache = new TranscriptionAudioCache();
  let finish!: (value: typeof audio) => void;
  const reading = new Promise<typeof audio>((resolve) => {
    finish = resolve;
  });
  const a = cache.load("a", () => reading);
  try {
    expect(cache.load("a", () => reading)).toBe(a);
    expect(cache.canWarm()).toBe(true);
    const failure = new Error("read failed");
    const b = cache.load("b", () => {
      throw failure;
    });
    expect(cache.canWarm()).toBe(false);
    await expect(b).rejects.toBe(failure);
    expect(cache.canWarm()).toBe(true);
    const c = cache.load("c", () => reading);
    expect(cache.canWarm()).toBe(false);
    finish(audio);
    await Promise.all([a, c]);
  } finally {
    finish(audio);
    await a;
  }
  expect(cache.canWarm()).toBe(true);
});
it("bounds entry count even for tiny clips", async () => {
  const cache = new TranscriptionAudioCache();
  const load = vi.fn(async () => audio);
  for (let i = 0; i < 5; i++) await cache.load(String(i), load);
  await cache.load("0", load);
  expect(load).toHaveBeenCalledTimes(6);
});
