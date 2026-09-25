import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampPlaybackProgress,
  formatDuration,
  playWebAudio,
  seekPlayback,
  stopActivePlayback,
} from "./audio-playback.utils";

describe("start progress clamp", () => {
  it("treats 1 as ended, not a source offset", () => {
    expect(clampPlaybackProgress(1)).toBe(1);
    expect(clampPlaybackProgress(1.2)).toBe(1);
  });
});

describe("clampPlaybackProgress", () => {
  it("clamps below 0 and above 1", () => {
    expect(clampPlaybackProgress(-0.2)).toBe(0);
    expect(clampPlaybackProgress(1.4)).toBe(1);
    expect(clampPlaybackProgress(0.33)).toBe(0.33);
  });
});

describe("formatDuration", () => {
  it("formats finite milliseconds", () => {
    expect(formatDuration(65000)).toBe("1:05");
  });

  it("returns 0:00 for missing values", () => {
    expect(formatDuration(null)).toBe("0:00");
    expect(formatDuration(undefined)).toBe("0:00");
  });
});

describe("audio source cleanup", () => {
  afterEach(() => {
    stopActivePlayback("stopped");
    vi.unstubAllGlobals();
  });

  it("disconnects the previous source during seek even when stopping it throws", async () => {
    const makeSource = () => ({
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(),
      onended: null,
    });
    const original = makeSource();
    const replacement = makeSource();
    const createSource = vi
      .fn()
      .mockReturnValueOnce(original)
      .mockReturnValue(replacement);
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        createBufferSource = createSource;
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    await playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
    );
    original.stop.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });
    expect(seekPlayback(0.5)).toBe(true);
    expect(original.disconnect).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledWith(0, 0.5);
  });
});
