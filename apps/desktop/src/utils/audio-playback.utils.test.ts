import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activePlayback,
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

  it("does not start audio for a stop pressed while the context was resuming", async () => {
    // `playWebAudio` publishes `activePlayback` only after every await has
    // settled, so a stop pressed inside that window finds nothing to tear down
    // and returns early. The generation counter is the only thing that can tell
    // the suspended call it has been superseded — and the guard it checks on
    // resumption still compares equal unless the stop advanced it, which let
    // the audio start after the user had already pressed stop.
    let releaseResume = (): void => {};
    const resumed = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const start = vi.fn();
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start,
      onended: null,
    };
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        currentTime = 0;
        destination = {};
        createBufferSource = () => source;
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        resume() {
          return resumed;
        }
        close() {
          return Promise.resolve();
        }
      },
    );

    const playing = playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
    );
    // Parked inside `resume()`: nothing is active yet, so this is the window the
    // stop has to be honoured in.
    expect(activePlayback).toBeNull();
    stopActivePlayback("stopped");
    releaseResume();
    await playing;

    expect(start).not.toHaveBeenCalled();
    expect(activePlayback).toBeNull();
  });
});

// `playWebAudio` allocates an AudioContext, which holds an OS audio handle, and
// publishes it as `activePlayback` only after every await has settled. An exit
// between the allocation and that publication — a rejected `resume()`, or a
// `createBuffer` that rejects the sample rate — therefore propagates out of
// `playWebAudio` with no owner left to close it. `AudioPlayerPill` catches that
// rejection and shows "Unable to play audio snippet", so the app recovers on
// screen while the context stays open for the life of the page. Playback is
// started per transcription row, so these accumulate.
describe("audio context lifetime", () => {
  afterEach(() => {
    stopActivePlayback("stopped");
    vi.unstubAllGlobals();
  });

  const stubIdleWindow = () => {
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
  };

  it("closes the context when resume rejects", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        currentTime = 0;
        destination = {};
        close = close;
        resume = vi.fn(() => Promise.reject(new Error("resume blocked")));
        createBufferSource = vi.fn();
        createBuffer = vi.fn();
      },
    );

    // The caller still has to learn playback failed, so the rejection must
    // keep propagating — closing the context is not allowed to swallow it.
    await expect(
      playWebAudio(
        "t1",
        { samples: [0, 0], sampleRate: 16000 },
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow("resume blocked");

    expect(close).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
  });

  it("closes the context when createBuffer rejects the sample rate", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        close = close;
        createBufferSource = vi.fn();
        createBuffer = vi.fn(() => {
          throw new Error("sample rate 0 outside [3000, 768000]");
        });
      },
    );

    await expect(
      playWebAudio("t1", { samples: [0, 0], sampleRate: 0 }, vi.fn(), vi.fn()),
    ).rejects.toThrow("sample rate 0 outside");

    expect(close).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
  });

  // The fix must not close the context it is supposed to hand over: that one is
  // the live playback, and closing it would silence the audio.
  it("leaves the context open once playback takes ownership of it", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        close = close;
        createBufferSource = vi.fn(() => ({
          stop: vi.fn(),
          disconnect: vi.fn(),
          connect: vi.fn(),
          start: vi.fn(),
          onended: null,
        }));
        createBuffer = vi.fn(() => ({
          duration: 1,
          getChannelData: () => new Float32Array(2),
        }));
      },
    );

    await playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
    );

    expect(close).not.toHaveBeenCalled();
    expect(activePlayback).not.toBeNull();
  });
});
