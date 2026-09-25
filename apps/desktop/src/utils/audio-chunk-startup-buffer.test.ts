import { describe, expect, it, vi } from "vitest";
import { createAudioChunkStartupBuffer } from "./audio-chunk-startup-buffer";

describe("createAudioChunkStartupBuffer", () => {
  it("copies and replays buffered chunks in order", () => {
    const buffer = createAudioChunkStartupBuffer();
    const sink = vi.fn();
    const source = new Float32Array([0.1, 0.2]);

    buffer.push(source);
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

    buffer.push(new Float32Array([1, 2, 3, 4, 5]));
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

    buffer.push(new Float32Array([1, 2, 3, 4, 5]));
    buffer.setSampleRate(16_000);
    buffer.setSink(sink);
    buffer.replay();

    expect(onOverflow).toHaveBeenLastCalledWith(3);
    expect(Array.from(sink.mock.calls[0][0] as Float32Array)).toEqual([1, 2]);
  });
});
