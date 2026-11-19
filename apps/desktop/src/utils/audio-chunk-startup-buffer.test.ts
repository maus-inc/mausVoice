import { describe, expect, it, vi } from "vitest";
import { createAudioChunkStartupBuffer } from "./audio-chunk-startup-buffer";

describe("createAudioChunkStartupBuffer", () => {
  it("copies and replays buffered chunks in order", () => {
    const buffer = createAudioChunkStartupBuffer();
    const sink = vi.fn();
    const source = new Float32Array([0.1, 0.2]);

    buffer.push(source, 0);
    source[0] = 0.9;
    buffer.setSink(sink);
    buffer.replay();

    expect(Array.from(sink.mock.calls[0][0] as Float32Array)[0]).toBeCloseTo(
      0.1,
      5,
    );
  });

  it("keeps the earliest samples when its duration budget is exceeded", () => {
    const onOverflow = vi.fn();
    const buffer = createAudioChunkStartupBuffer(onOverflow, 0.00005, 48_000);
    const sink = vi.fn();

    buffer.push(new Float32Array([1, 2, 3, 4, 5]), 0);
    buffer.setSink(sink);
    buffer.replay();

    expect(buffer.overflowed()).toBe(true);
    expect(onOverflow).toHaveBeenCalledWith(2);
    expect(Array.from(sink.mock.calls[0][0] as Float32Array)).toEqual([
      1, 2, 3,
    ]);
  });

  it("trims buffered samples when the real capture rate lowers the budget", () => {
    const onOverflow = vi.fn();
    const buffer = createAudioChunkStartupBuffer(onOverflow, 0.0001, 48_000);
    const sink = vi.fn();

    buffer.push(new Float32Array([1, 2, 3, 4, 5]), 0);
    buffer.setSampleRate(16_000);
    buffer.setSink(sink);
    buffer.replay();

    expect(onOverflow).toHaveBeenLastCalledWith(3);
    expect(Array.from(sink.mock.calls[0][0] as Float32Array)).toEqual([1, 2]);
  });

  it("reports pending samples and clears them on reset", () => {
    const buffer = createAudioChunkStartupBuffer();
    const sink = vi.fn();

    buffer.push(new Float32Array([1, 2, 3]), 10);
    expect(buffer.pendingSampleCount()).toBe(3);
    expect(buffer.overflowed()).toBe(false);

    buffer.reset();
    expect(buffer.pendingSampleCount()).toBe(0);
    expect(buffer.overflowed()).toBe(false);

    buffer.setSink(sink);
    buffer.replay();
    expect(sink).not.toHaveBeenCalled();
  });

  it("clears the overflow flag on reset", () => {
    const buffer = createAudioChunkStartupBuffer(vi.fn(), 0.00005, 48_000);

    buffer.push(new Float32Array([1, 2, 3, 4, 5]), 0);
    expect(buffer.overflowed()).toBe(true);

    buffer.reset();
    expect(buffer.overflowed()).toBe(false);
  });

  it("ignores an empty chunk", () => {
    const buffer = createAudioChunkStartupBuffer();

    buffer.push(new Float32Array(0), 0);
    expect(buffer.pendingSampleCount()).toBe(0);
  });

  it("replays every buffered chunk with its own sample index", () => {
    const buffer = createAudioChunkStartupBuffer();
    const seen: Array<[number, number]> = [];
    buffer.push(new Float32Array([1, 2]), 100);
    buffer.push(new Float32Array([3, 4]), 102);
    buffer.push(new Float32Array([5]), 104);

    buffer.setSink((chunk, offset) => seen.push([chunk[0], offset]));
    buffer.replay();

    expect(seen).toEqual([
      [1, 100],
      [3, 102],
      [5, 104],
    ]);
  });

  it("keeps a trimmed chunk's index when the budget shrinks", () => {
    const onOverflow = vi.fn();
    const buffer = createAudioChunkStartupBuffer(onOverflow, 0.0001, 48_000);
    const seen: Array<[number, number]> = [];

    buffer.push(new Float32Array([1, 2, 3, 4, 5]), 20);
    buffer.setSampleRate(16_000);
    buffer.setSink((chunk, offset) => seen.push([chunk[0], offset]));
    buffer.replay();

    expect(seen).toEqual([[1, 20]]);
  });

  it("replays nothing while no sink is installed", () => {
    const buffer = createAudioChunkStartupBuffer();
    buffer.push(new Float32Array([1, 2]), 0);
    buffer.replay();
    expect(buffer.pendingSampleCount()).toBe(2);
  });
});
