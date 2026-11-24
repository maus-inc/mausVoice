import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRecordingLease } from "./browser-recording-lease";
import { encodeRecordedAudio } from "./recorded-audio.utils";
import {
  acquireLocalBrowserRecording,
  releaseLocalBrowserRecording,
} from "./local-recording-activity";
import {
  beginNativeRecording,
  currentNativeRecording,
  discardNativeRecording,
  invokeStopRecording,
  pauseNativeRecording,
  resetNativeRecordingSession,
  resumeNativeRecording,
  stopNativeRecording,
  type NativeRecordingHandle,
} from "./native-recording-session";

type Call = [string, unknown?];

const recorderTransport = (
  overrides: Record<string, (args?: unknown) => Promise<unknown>> = {},
) => {
  let generation = 0;
  const calls: Call[] = [];
  const invoke = vi.fn((command: string, args?: unknown) => {
    calls.push([command, args]);
    if (overrides[command]) return overrides[command](args);
    switch (command) {
      case "recording_generation":
        generation += 1;
        return Promise.resolve(generation);
      case "start_recording":
        return Promise.resolve({ sampleRate: 16_000 });
      case "stop_recording":
        return Promise.resolve(new ArrayBuffer(4));
      default:
        return Promise.resolve(undefined);
    }
  });
  return { invoke, calls };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => resetNativeRecordingSession());

describe("beginNativeRecording", () => {
  it("exposes the admission before native capture can emit chunks", async () => {
    let admitted: NativeRecordingHandle | null = null;
    const { invoke } = recorderTransport({
      start_recording: (args) => {
        expect(admitted).not.toBeNull();
        expect(args).toMatchObject({
          ownerId: admitted!.ownerId,
          generation: admitted!.generation,
        });
        return Promise.resolve({ sampleRate: 16_000 });
      },
    });
    const { handle } = await beginNativeRecording(
      null,
      {
        onAdmission: (next) => {
          admitted = next;
        },
      },
      invoke,
    );
    expect(admitted).toBe(handle);
    await handle.discard();
  });

  it("cleans up an admission callback failure without opening capture", async () => {
    const { invoke, calls } = recorderTransport();
    await expect(
      beginNativeRecording(
        null,
        {
          onAdmission: () => {
            throw new Error("admission setup failed");
          },
        },
        invoke,
      ),
    ).rejects.toThrow("admission setup failed");
    expect(calls.some(([command]) => command === "start_recording")).toBe(
      false,
    );
    expect(calls.some(([command]) => command === "discard_recording")).toBe(
      true,
    );
    expect(currentNativeRecording()).toBeNull();
    const browserOwner = {};
    expect(acquireLocalBrowserRecording(invoke, browserOwner)).toBe(true);
    releaseLocalBrowserRecording(invoke, browserOwner);
  });

  it("reserves a generation and starts under it", async () => {
    const { invoke, calls } = recorderTransport();
    const { sampleRate, handle } = await beginNativeRecording(
      "mic-1",
      {},
      invoke,
    );

    expect(sampleRate).toBe(16_000);
    expect(handle.generation).toBe(1);
    expect(calls).toEqual([
      ["recording_generation", { ownerId: handle.ownerId }],
      [
        "start_recording",
        {
          ownerId: handle.ownerId,
          generation: 1,
          args: { preferredMicrophone: "mic-1" },
        },
      ],
    ]);
    expect(currentNativeRecording()).toBe(handle);
  });

  it("passes waitForRelease through to the start", async () => {
    const { invoke, calls } = recorderTransport();
    await beginNativeRecording(null, { waitForRelease: true }, invoke);
    expect(calls[1]?.[1]).toMatchObject({
      args: { preferredMicrophone: null, waitForRelease: true },
    });
  });

  it("rejects a generation the transport did not really hand out", async () => {
    const { invoke } = recorderTransport({
      recording_generation: () => Promise.resolve(undefined),
    });
    await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
      "Invalid recording generation",
    );
    expect(currentNativeRecording()).toBeNull();
  });

  it("refuses another start while the first admission is pending", async () => {
    let releaseGeneration!: (generation: number) => void;
    const pendingGeneration = new Promise<number>((resolve) => {
      releaseGeneration = resolve;
    });
    let requests = 0;
    const { invoke } = recorderTransport({
      recording_generation: () =>
        ++requests === 1 ? pendingGeneration : Promise.resolve(2),
    });

    const first = beginNativeRecording(null, {}, invoke);
    const second = beginNativeRecording(null, {}, invoke);
    await expect(second).rejects.toThrow(
      "A recording start is already in progress",
    );
    releaseGeneration(1);
    const { handle } = await first;
    expect(currentNativeRecording()).toBe(handle);
    expect(handle.isLive()).toBe(true);
    await handle.discard();
  });

  it.each(["during discard", "on release"])(
    "admits only one successor when a competitor starts %s",
    async (timing) => {
      const opened = { sampleRate: 16_000 };
      const firstReply = deferred<typeof opened>();
      const release = deferred<void>();
      const winnerReply = deferred<typeof opened>();
      const discard = vi
        .fn(() => Promise.resolve())
        .mockRejectedValueOnce(new Error("device held"))
        .mockImplementationOnce(() => release.promise);
      const { invoke, calls } = recorderTransport({
        start_recording: vi
          .fn(() => Promise.resolve(opened))
          .mockImplementationOnce(() => firstReply.promise)
          .mockImplementationOnce(() => winnerReply.promise),
        discard_recording: discard,
      });
      const first = beginNativeRecording(null, { handleScoped: true }, invoke);
      try {
        await vi.waitFor(() => expect(currentNativeRecording()).not.toBeNull());
        const old = currentNativeRecording()!;
        await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
          "already in progress",
        );
        expect(discard).not.toHaveBeenCalled();
        await expect(old.discard()).rejects.toThrow("device held");
        // A legacy retry could supersede live audio if the post-wait check were lost.
        const retry = beginNativeRecording("retry", {}, invoke);
        const compete = () =>
          beginNativeRecording("competitor", { handleScoped: true }, invoke);
        // Joining the actual discard schedules the competitor at confirmation,
        // before the bounded release waiter resumes. No timer chooses the winner.
        const during = timing === "during discard";
        const competitor = during ? compete() : old.discard().then(compete);
        const waiters = Promise.allSettled([retry, competitor]);
        expect(calls.filter(([name]) => name === "discard_recording")).toEqual([
          ["discard_recording", { ownerId: old.ownerId, generation: 1 }],
          ["discard_recording", { ownerId: old.ownerId, generation: 1 }],
        ]);
        expect(
          calls.filter(([name]) => name === "recording_generation"),
        ).toHaveLength(1);
        release.resolve();
        await expect(during ? competitor : retry).rejects.toThrow(
          "start is already in progress",
        );
        await vi.waitFor(() =>
          expect(
            calls.filter(([cmd]) => cmd === "start_recording"),
          ).toHaveLength(2),
        );
        const starts = calls.filter(([cmd]) => cmd === "start_recording");
        expect(starts[1]?.[1]).toMatchObject({
          generation: 2,
          args: { preferredMicrophone: during ? "retry" : "competitor" },
        });
        expect(
          calls.filter(([cmd]) => cmd === "recording_generation"),
        ).toHaveLength(2);
        winnerReply.resolve(opened);
        expect(
          (await waiters).filter((r) => r.status === "fulfilled"),
        ).toHaveLength(1);
        expect(currentNativeRecording()?.generation).toBe(2);
        firstReply.resolve(opened);
        await (await first).handle.discard();
        expect(currentNativeRecording()?.generation).toBe(2);
      } finally {
        winnerReply.resolve(opened);
        release.resolve();
        firstReply.resolve(opened);
        await first;
        await currentNativeRecording()?.discard();
      }
    },
  );

  it.each(["stop", "failed discard"])(
    "keeps the legacy opening after %s until its late cleanup",
    async (action) => {
      let opened!: () => void;
      const opening = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let startReply!: (reply: { sampleRate: number }) => void;
      const discard = vi
        .fn(() => Promise.resolve())
        .mockRejectedValueOnce(new Error("device held"));
      const { invoke } = recorderTransport({
        discard_recording: discard,
        start_recording: () =>
          new Promise((resolve) => {
            startReply = resolve;
            opened();
          }),
      });
      // MicCheckForm can stop on unmount, then discard globally when its old
      // start returns. That caller does not promise handle-scoped cleanup.
      const lateCleanup = beginNativeRecording(null, {}, invoke).then(() =>
        discardNativeRecording(),
      );
      await opening;
      const next = recorderTransport();
      try {
        if (action === "stop") await stopNativeRecording(invoke);
        else
          await expect(currentNativeRecording()!.discard()).rejects.toThrow(
            "device held",
          );
        await expect(
          beginNativeRecording(null, {}, next.invoke),
        ).rejects.toThrow("start is already in progress");
        expect(discard).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
      } finally {
        startReply({ sampleRate: 16_000 });
        await lateCleanup;
      }
      const { handle } = await beginNativeRecording(null, {}, next.invoke);
      expect(
        next.calls.filter(([cmd]) => cmd === "discard_recording"),
      ).toHaveLength(0);
      expect(handle.isLive()).toBe(true);
      await handle.discard();
    },
  );

  it("keeps the start guard through cleanup and releases it after failure", async () => {
    let rejectStart!: (error: Error) => void;
    let releaseDiscard!: () => void;
    const start = new Promise<unknown>((_, reject) => {
      rejectStart = reject;
    });
    const discard = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    const { invoke } = recorderTransport({
      start_recording: () => start,
      discard_recording: () => discard,
    });

    const first = beginNativeRecording(null, {}, invoke);
    const firstFailure = expect(first).rejects.toThrow("no mic");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", expect.anything()),
    );
    rejectStart(new Error("no mic"));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "discard_recording",
        expect.anything(),
      ),
    );
    await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
      "A recording start is already in progress",
    );
    releaseDiscard();
    await firstFailure;
    const next = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, next.invoke);
    expect(handle.isLive()).toBe(true);
    await handle.discard();
  });

  it("releases the recorder when the start fails", async () => {
    const { invoke, calls } = recorderTransport({
      start_recording: () => Promise.reject(new Error("no mic")),
    });
    await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
      "no mic",
    );
    expect(calls.map(([command]) => command)).toContain("discard_recording");
    expect(currentNativeRecording()).toBeNull();
  });

  it("rejects an unusable start reply and releases the recorder", async () => {
    const { invoke, calls } = recorderTransport({
      start_recording: () => Promise.resolve({}),
    });
    await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
      "Invalid recording start response",
    );
    expect(calls.map(([command]) => command)).toContain("discard_recording");
  });
});

describe("partial capture release", () => {
  it("stops retrying a rejected discard instead of leaving a timer running", async () => {
    vi.useFakeTimers();
    try {
      const partial = encodeRecordedAudio([0.25], 16_000);
      new DataView(partial.buffer, partial.byteOffset).setUint32(
        0,
        0x80000000 + 16_000,
        true,
      );
      let discards = 0;
      const { invoke } = recorderTransport({
        stop_recording: () => Promise.resolve(partial),
        discard_recording: () => {
          discards += 1;
          return Promise.reject(new Error("device stuck"));
        },
      });
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const stopped = handle.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect((await stopped).captureFailed).toBe(true);

      // Each rejected attempt schedules the next, and the cap ends the chain.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(discards).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(discards).toBe(3);
    } finally {
      vi.useRealTimers();
      resetNativeRecordingSession();
    }
  });
});

describe("stopping", () => {
  it("a replacement already waiting on stop waits for partial capture release too", async () => {
    let deliver!: (value: Uint8Array) => void;
    let release!: () => void;
    const stop = new Promise<Uint8Array>((resolve) => {
      deliver = resolve;
    });
    const discard = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { invoke, calls } = recorderTransport({
      stop_recording: () => stop,
      discard_recording: () => discard,
    });
    const { handle } = await beginNativeRecording(null, {}, invoke);
    const stopping = handle.stop();
    const next = beginNativeRecording(null, { handleScoped: true }, invoke);
    const partial = encodeRecordedAudio([0.25], 16_000);
    new DataView(partial.buffer, partial.byteOffset).setUint32(
      0,
      0x80000000 + 16_000,
      true,
    );
    deliver(partial);
    try {
      expect((await stopping).captureFailed).toBe(true);
      await expect(handle.pause()).rejects.toThrow(
        "No native recording is active",
      );
      await expect(handle.resume()).rejects.toThrow(
        "No native recording is active",
      );
      expect(
        calls.filter(([cmd]) => cmd === "recording_generation"),
      ).toHaveLength(1);
      expect(invoke).not.toHaveBeenCalledWith(
        "pause_recording",
        expect.anything(),
      );
    } finally {
      release();
      const replacement = await next;
      await replacement.handle.discard();
    }
    expect(
      calls.filter(([cmd]) => cmd === "recording_generation"),
    ).toHaveLength(2);
  });

  it("presents the admission and acknowledges the audio", async () => {
    const { invoke, calls } = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, invoke);

    await stopNativeRecording(invoke);

    expect(calls.slice(2)).toEqual([
      [
        "stop_recording",
        { ownerId: handle.ownerId, generation: handle.generation },
      ],
      [
        "acknowledge_recording",
        { ownerId: handle.ownerId, generation: handle.generation },
      ],
    ]);
    expect(currentNativeRecording()).toBeNull();
  });

  it("a stalled acknowledgement does not hold the admission", async () => {
    // CodeAnt Major: acknowledge_recording only drops native's recovery copy.
    // If it never settles, the stop must still resolve and free the local
    // admission so a later start cannot wait on it forever.
    const { invoke, calls } = recorderTransport({
      acknowledge_recording: () => new Promise<never>(() => {}),
    });
    await beginNativeRecording(null, {}, invoke);

    const stopping = await Promise.race([
      stopNativeRecording(invoke).then(() => "settled" as const),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 500),
      ),
    ]);
    expect(stopping).toBe("settled");

    const starting = await Promise.race([
      beginNativeRecording(null, {}, invoke).then(() => "started" as const),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 500),
      ),
    ]);
    expect(starting).toBe("started");
    expect(calls.map(([command]) => command)).toContain(
      "acknowledge_recording",
    );
  });

  it("drops the audio and its admission on discard", async () => {
    const { invoke, calls } = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, invoke);

    await discardNativeRecording();

    expect(calls.at(-1)).toEqual([
      "discard_recording",
      { ownerId: handle.ownerId, generation: handle.generation },
    ]);
    expect(currentNativeRecording()).toBeNull();
  });

  it("does nothing when no recording is live", async () => {
    const { invoke } = recorderTransport();
    await expect(stopNativeRecording(invoke)).resolves.toEqual({
      samples: new Float32Array(0),
      sampleRate: 0,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("waits for the older stop before admitting a successor", async () => {
    let resolveStop!: (payload: ArrayBuffer) => void;
    const stop = new Promise<ArrayBuffer>((resolve) => {
      resolveStop = resolve;
    });
    const { invoke, calls } = recorderTransport({ stop_recording: () => stop });
    await beginNativeRecording(null, {}, invoke);
    const stopping = stopNativeRecording(invoke);
    const starting = beginNativeRecording(null, {}, invoke);
    await Promise.resolve();
    expect(
      calls.filter(([command]) => command === "recording_generation"),
    ).toHaveLength(1);

    resolveStop(new ArrayBuffer(4));
    await stopping;
    const { handle: successor } = await starting;
    expect(currentNativeRecording()).toBe(successor);
    expect(acquireLocalBrowserRecording(invoke, {})).toBe(false);
    await successor.discard();
    const browserOwner = {};
    expect(acquireLocalBrowserRecording(invoke, browserOwner)).toBe(true);
    releaseLocalBrowserRecording(invoke, browserOwner);
  });

  it.each(["global", "owned"])(
    "shares the audio from a pending %s stop with global teardown",
    async (kind) => {
      let resolveStop!: (payload: Uint8Array) => void;
      const stop = new Promise<Uint8Array>((resolve) => {
        resolveStop = resolve;
      });
      const { invoke, calls } = recorderTransport({
        stop_recording: () => stop,
      });
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const first =
        kind === "owned" ? handle.stop() : stopNativeRecording(invoke);
      const second = stopNativeRecording(invoke);
      // An early empty result is not the captured sample, even if only one
      // IPC stop was sent. Both waiters must receive the real response.
      resolveStop(encodeRecordedAudio([0.75], 16_000));
      const [original, joined] = await Promise.all([first, second]);
      expect(original).toEqual({
        samples: Float32Array.of(0.75),
        sampleRate: 16_000,
      });
      expect(joined).toEqual(original);
      expect(
        calls.filter(([command]) => command === "stop_recording"),
      ).toHaveLength(1);
    },
  );

  it("clears the in-flight stop when a transport throws synchronously", async () => {
    const { invoke } = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, invoke);
    const throwing = () => {
      throw new Error("synchronous failure");
    };
    await expect(stopNativeRecording(throwing)).rejects.toThrow(
      "synchronous failure",
    );
    expect(currentNativeRecording()).toBe(handle);
    await stopNativeRecording(invoke);
    const browserOwner = {};
    expect(acquireLocalBrowserRecording(invoke, browserOwner)).toBe(true);
    releaseLocalBrowserRecording(invoke, browserOwner);
  });

  it.each(["global", "owned"])(
    "does not orphan a failed %s stop when a successor begins",
    async (kind) => {
      let rejectStop!: (error: Error) => void;
      const stop = new Promise<ArrayBuffer>((_, reject) => {
        rejectStop = reject;
      });
      let stopCalls = 0;
      const { invoke } = recorderTransport({
        stop_recording: () =>
          ++stopCalls === 1 ? stop : Promise.resolve(new ArrayBuffer(4)),
      });
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const stopping =
        kind === "owned" ? handle.stop() : stopNativeRecording(invoke);
      const stopFailure = expect(stopping).rejects.toThrow("transport down");
      const successor = beginNativeRecording(null, {}, invoke);
      const successorFailure =
        expect(successor).rejects.toThrow("transport down");
      rejectStop(new Error("transport down"));
      await stopFailure;
      await successorFailure;
      expect(currentNativeRecording()).toBe(handle);
      await stopNativeRecording(invoke);
      const browserOwner = {};
      expect(acquireLocalBrowserRecording(invoke, browserOwner)).toBe(true);
      releaseLocalBrowserRecording(invoke, browserOwner);
    },
  );

  it("a superseded handle cannot join its successor's pending stop", async () => {
    let finish!: (payload: ArrayBuffer) => void;
    const stop = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    const { invoke, calls } = recorderTransport({ stop_recording: () => stop });
    const first = await beginNativeRecording(null, {}, invoke);
    const second = await beginNativeRecording(null, {}, invoke);
    const current = second.handle.stop();
    const stale = first.handle.stop();
    const refused = expect(stale).rejects.toThrow("no longer owned");
    finish(new Uint32Array([16_000]).buffer);
    await refused;
    expect((await current).sampleRate).toBe(16_000);
    expect(calls.filter(([cmd]) => cmd === "stop_recording")).toEqual([
      [
        "stop_recording",
        {
          ownerId: second.handle.ownerId,
          generation: second.handle.generation,
        },
      ],
    ]);
  });

  it("discards the same admission if a pending stop fails during abort", async () => {
    let rejectStop!: (error: Error) => void;
    const stop = new Promise<ArrayBuffer>((_, reject) => {
      rejectStop = reject;
    });
    const { invoke, calls } = recorderTransport({ stop_recording: () => stop });
    const { handle } = await beginNativeRecording(null, {}, invoke);
    const stopping = stopNativeRecording(invoke);
    const failure = expect(stopping).rejects.toThrow("stop failed");
    const discarding = discardNativeRecording();
    rejectStop(new Error("stop failed"));
    await failure;
    await discarding;
    expect(
      calls.filter(([command]) => command === "discard_recording"),
    ).toEqual([
      [
        "discard_recording",
        { ownerId: handle.ownerId, generation: handle.generation },
      ],
    ]);
    expect(currentNativeRecording()).toBeNull();
  });

  it("does not discard a successor if the pending stop succeeds", async () => {
    let resolveStop!: (payload: ArrayBuffer) => void;
    const stop = new Promise<ArrayBuffer>((resolve) => {
      resolveStop = resolve;
    });
    const { invoke, calls } = recorderTransport({ stop_recording: () => stop });
    await beginNativeRecording(null, {}, invoke);
    const stopping = stopNativeRecording(invoke);
    const starting = beginNativeRecording(null, {}, invoke);
    const discarding = discardNativeRecording();
    resolveStop(new ArrayBuffer(4));
    await stopping;
    const { handle: successor } = await starting;
    await discarding;
    expect(currentNativeRecording()).toBe(successor);
    expect(
      calls.filter(([command]) => command === "discard_recording"),
    ).toHaveLength(0);
    await successor.discard();
  });

  it("holds a failed discard's slot until release is confirmed", async () => {
    let releaseWorks = false;
    const { invoke, calls } = recorderTransport({
      stop_recording: () => Promise.reject(new Error("stop failed")),
      discard_recording: async () => {
        if (!releaseWorks) throw new Error("release unconfirmed");
      },
    });
    const { handle } = await beginNativeRecording(null, {}, invoke);
    await expect(handle.stop()).rejects.toThrow("stop failed");
    await expect(handle.discard()).rejects.toThrow("release unconfirmed");
    expect(acquireLocalBrowserRecording(invoke, {})).toBe(false);
    await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
      "release unconfirmed",
    );
    expect(
      calls.filter(([cmd]) => cmd === "recording_generation"),
    ).toHaveLength(1);
    releaseWorks = true;
    const { handle: next } = await beginNativeRecording(null, {}, invoke);
    expect(next.generation).toBe(2);
    await next.discard();
    const browserOwner = {};
    expect(acquireLocalBrowserRecording(invoke, browserOwner)).toBe(true);
    releaseLocalBrowserRecording(invoke, browserOwner);
  });

  it("times out replacement waiters without retiring the pending discard", async () => {
    vi.useFakeTimers();
    let confirm!: () => void;
    const pending = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const { invoke, calls } = recorderTransport({
      discard_recording: () => pending,
    });
    try {
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const cleanup = handle.discard();
      const browser = new BrowserRecordingLease(invoke);
      const failed = vi.fn();
      // Clear and Delete Account stop the same webview through this entry point.
      const clearWait = stopNativeRecording(invoke).catch(failed);
      const nativeWait = beginNativeRecording(null, {}, invoke).catch(failed);
      const browserWait = browser.acquire().catch(failed);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed.mock.calls.map(([error]) => error.message)).toEqual([
        "Recording release timed out after 2000ms",
        "Recording release timed out after 2000ms",
        "Recording release timed out after 2000ms",
      ]);
      await Promise.all([clearWait, nativeWait, browserWait]);
      expect(acquireLocalBrowserRecording(invoke, {})).toBe(false);
      expect(calls.filter(([cmd]) => cmd === "discard_recording")).toEqual([
        [
          "discard_recording",
          { ownerId: handle.ownerId, generation: handle.generation },
        ],
      ]);
      expect(
        calls.filter(([cmd]) => cmd === "recording_generation"),
      ).toHaveLength(1);
      expect(calls.some(([cmd]) => cmd === "claim_browser_recording")).toBe(
        false,
      );
      confirm();
      await cleanup;
      await browser.acquire();
      expect(invoke).toHaveBeenCalledWith("claim_browser_recording", {
        ownerId: expect.any(String),
        generation: 2,
      });
      await browser.release();
      const { handle: next } = await beginNativeRecording(null, {}, invoke);
      expect(next.generation).toBe(3);
      await next.discard();
    } finally {
      confirm();
      vi.useRealTimers();
    }
  });

  it("joins a pending discard without returning abandoned audio or opening another stream early", async () => {
    let confirm!: () => void;
    const release = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    let confirmed = false;
    const confirmedAtReservation: boolean[] = [];
    const { invoke, calls } = recorderTransport({
      recording_generation: async () => confirmedAtReservation.push(confirmed),
      discard_recording: async () => {
        await release;
        confirmed = true;
      },
    });
    const { handle } = await beginNativeRecording(null, {}, invoke);
    const discarding = handle.discard();
    const stopped = stopNativeRecording(invoke).then((audio) => ({
      audio,
      confirmed,
    }));
    const next = beginNativeRecording(null, {}, invoke);
    setImmediate(confirm);
    const [, observedStop, { handle: successor }] = await Promise.all([
      discarding,
      stopped,
      next,
    ]);
    expect(confirmedAtReservation).toEqual([false, true]);
    expect(observedStop.confirmed).toBe(true);
    expect(observedStop.audio.samples).toHaveLength(0);
    expect(calls.filter(([cmd]) => cmd === "stop_recording")).toHaveLength(0);
    expect(calls.filter(([cmd]) => cmd === "discard_recording")).toEqual([
      [
        "discard_recording",
        { ownerId: handle.ownerId, generation: handle.generation },
      ],
    ]);
    expect(successor.isLive()).toBe(true);
    await successor.discard();
  });

  it("keeps a failed stop addressable for a later retry", async () => {
    const { invoke } = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, invoke);
    const failing = recorderTransport({
      stop_recording: () => Promise.reject(new Error("transport down")),
    });

    await expect(stopNativeRecording(failing.invoke)).rejects.toThrow(
      "transport down",
    );
    expect(currentNativeRecording()).toBe(handle);
  });
});

describe("pause and resume", () => {
  it("addresses the live admission", async () => {
    const { invoke, calls } = recorderTransport();
    const { handle } = await beginNativeRecording(null, {}, invoke);

    await pauseNativeRecording(invoke);
    await resumeNativeRecording(invoke);

    expect(calls.slice(2)).toEqual([
      ["pause_recording", { ownerId: handle.ownerId, generation: 1 }],
      ["resume_recording", { ownerId: handle.ownerId, generation: 1 }],
    ]);
  });

  it("refuses to control a recorder it does not own", async () => {
    const { invoke } = recorderTransport();
    await expect(pauseNativeRecording(invoke)).rejects.toThrow(
      "No native recording is active",
    );
  });
});

describe("invokeStopRecording", () => {
  it("decodes what an injected transport returned", async () => {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(0, 16_000, true);
    new DataView(payload.buffer).setFloat32(4, 0.5, true);
    const invokeFn = vi.fn(() => Promise.resolve(payload));

    const decoded = await invokeStopRecording(invokeFn);

    expect(invokeFn).toHaveBeenCalledWith("stop_recording");
    expect(Array.from(decoded.samples)).toEqual([0.5]);
  });
});
