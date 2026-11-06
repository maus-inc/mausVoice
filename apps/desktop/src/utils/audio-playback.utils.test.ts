import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activePlayback,
  clampPlaybackProgress,
  formatDuration,
  playWebAudio,
  playWebAudioCancellable,
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

  it("does not let a retired request abort a newer playback", async () => {
    let releaseResume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const starts = [vi.fn(), vi.fn()];
    let contexts = 0;
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        index = contexts++;
        state = this.index === 0 ? "suspended" : "running";
        currentTime = 0;
        destination = {};
        resume() {
          return resumed;
        }
        close() {
          return Promise.resolve();
        }
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        createBufferSource() {
          return {
            start: starts[this.index],
            connect: vi.fn(),
            stop: vi.fn(),
            disconnect: vi.fn(),
            onended: null,
          };
        }
      },
    );
    const first = new AbortController();
    const second = new AbortController();
    const oldPlayback = playWebAudioCancellable(
      "old",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
      0,
      first.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(contexts).toBe(1);
    await playWebAudioCancellable(
      "new",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
      0,
      second.signal,
    );
    expect(activePlayback?.transcriptionId).toBe("new");
    first.abort();
    expect(activePlayback?.transcriptionId).toBe("new");
    releaseResume();
    await oldPlayback;
    expect(starts[0]).not.toHaveBeenCalled();
    expect(starts[1]).toHaveBeenCalledOnce();
    expect(activePlayback?.transcriptionId).toBe("new");
  });

  it("does not replace current audio when the caller is already aborted", async () => {
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
        close() {
          return Promise.resolve();
        }
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        createBufferSource() {
          return {
            start: vi.fn(),
            connect: vi.fn(),
            stop: vi.fn(),
            disconnect: vi.fn(),
            onended: null,
          };
        }
      },
    );
    await playWebAudio(
      "current",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
    );
    const controller = new AbortController();
    controller.abort();
    await playWebAudioCancellable(
      "cancelled",
      { samples: [0, 0], sampleRate: 16000 },
      vi.fn(),
      vi.fn(),
      0,
      controller.signal,
    );
    expect(activePlayback?.transcriptionId).toBe("current");
  });

  it("does not start audio for a stop pressed while the context was resuming", async () => {
    // `playWebAudio` publishes `activePlayback` only after every await has
    // settled, so a stop pressed inside that window finds nothing to tear down
    // and returns early. The generation counter is the only thing that can tell
    // the suspended call it has been superseded — and the guard it checks on
    // resumption still compares equal unless the stop advanced it, which let
    // the audio start after the user had already pressed stop.
    // Placeholder for the resolver the resumed promise's executor assigns
    // immediately below.
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

// The other side of that hand-off. `activePlayback` takes the context before
// the source is started and before the progress tick is armed, so an exit from
// the setup that follows has already given the context an owner -- and an owner
// the scheduled teardown never reaches: `source.onended` fires only for a source
// that started, and `armTick` has not run yet. Without an explicit release the
// context stays open and `activePlayback` keeps pointing at a playback that
// will never make a sound: the same handle leak the close above removes, moved
// to the far side of the hand-off. `AudioPlayerPill` catches the rejection and
// shows "Unable to play audio snippet", so the app looks like it failed cleanly
// while the handle survives.
describe("audio context release after ownership", () => {
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

  const stubContext = (
    close: () => Promise<void>,
    source: Record<string, unknown>,
  ) => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        close = close;
        createBufferSource = vi.fn(() => source);
        createBuffer = vi.fn(() => ({
          duration: 1,
          getChannelData: () => new Float32Array(2),
        }));
      },
    );
  };

  it("closes the context and clears the owner when source.start throws", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(() => {
        throw new DOMException("cannot start", "InvalidStateError");
      }),
      onended: null,
    };
    stubContext(close, source);

    // The caller still has to learn playback failed, so the original rejection
    // has to survive the teardown rather than being replaced by it.
    await expect(
      playWebAudio(
        "t1",
        { samples: [0, 0], sampleRate: 16000 },
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow("cannot start");

    expect(close).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
    // Teardown reached the node it owns, rather than only closing the context.
    expect(source.disconnect).toHaveBeenCalled();
  });

  it("does not start a source when its initial progress callback stops playback", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    stubContext(close, source);
    const onStop = vi.fn();
    await playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      () => {
        stopActivePlayback("stopped");
      },
      onStop,
    );
    expect(source.start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith("stopped");
    expect(activePlayback).toBeNull();
  });

  it("does not schedule another animation frame after a progress callback stops playback", async () => {
    let tick!: FrameRequestCallback;
    const request = vi.fn((callback: FrameRequestCallback) => {
      tick = callback;
      return 1;
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: request,
      cancelAnimationFrame: vi.fn(),
    });
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    stubContext(close, source);
    let calls = 0;
    await playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      () => {
        calls += 1;
        if (calls === 2) stopActivePlayback("stopped");
      },
      vi.fn(),
    );
    expect(request).toHaveBeenCalledOnce();
    tick(0);
    expect(request).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
  });

  it("does not report ended after a final progress callback stopped playback", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    stubContext(close, source);
    const onStop = vi.fn();
    await playWebAudio(
      "t1",
      { samples: [0, 0], sampleRate: 16000 },
      () => {
        stopActivePlayback("stopped");
      },
      onStop,
      1,
    );
    expect(source.start).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith("stopped");
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the playback error when the stop callback also throws", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(() => {
        throw new Error("start failed");
      }),
      onended: null,
    };
    stubContext(close, source);
    await expect(
      playWebAudio(
        "t1",
        { samples: [0, 0], sampleRate: 16000 },
        vi.fn(),
        () => {
          throw new Error("stop handler failed");
        },
      ),
    ).rejects.toThrow("start failed");
    expect(close).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
  });

  it("releases the context when the progress callback throws after ownership", async () => {
    stubIdleWindow();
    const close = vi.fn(() => Promise.resolve());
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    stubContext(close, source);

    await expect(
      playWebAudio(
        "t1",
        { samples: [0, 0], sampleRate: 16000 },
        vi.fn(() => {
          throw new Error("progress handler exploded");
        }),
        vi.fn(),
      ),
    ).rejects.toThrow("progress handler exploded");

    expect(close).toHaveBeenCalledOnce();
    expect(activePlayback).toBeNull();
    // The source never started, so there is no `onended` to wait for; leaving
    // it unstarted is the correct teardown for a playback that never played.
    expect(source.start).not.toHaveBeenCalled();
  });
});
