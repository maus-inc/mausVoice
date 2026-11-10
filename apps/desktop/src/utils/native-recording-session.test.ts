import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("discards a superseded recording before admitting a new one", async () => {
    const { invoke, calls } = recorderTransport();
    const first = await beginNativeRecording(null, {}, invoke);
    const second = await beginNativeRecording(null, {}, invoke);

    expect(calls.map(([command]) => command)).toEqual([
      "recording_generation",
      "start_recording",
      // The superseded stream is released before a second admission exists.
      "discard_recording",
      "recording_generation",
      "start_recording",
    ]);
    expect(calls[2]?.[1]).toEqual({
      ownerId: first.handle.ownerId,
      generation: first.handle.generation,
    });
    expect(currentNativeRecording()).toBe(second.handle);
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

describe("stopping", () => {
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

  it("shares a pending stop instead of reporting an empty recording", async () => {
    let resolveStop!: (payload: ArrayBuffer) => void;
    const stop = new Promise<ArrayBuffer>((resolve) => {
      resolveStop = resolve;
    });
    const { invoke, calls } = recorderTransport({ stop_recording: () => stop });
    await beginNativeRecording(null, {}, invoke);
    const first = stopNativeRecording(invoke);
    const second = stopNativeRecording(invoke);
    resolveStop(new ArrayBuffer(4));
    expect(await first).toEqual(await second);
    expect(
      calls.filter(([command]) => command === "stop_recording"),
    ).toHaveLength(1);
  });

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

  it("does not orphan a failed stop when a successor begins", async () => {
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
    const stopping = stopNativeRecording(invoke);
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
