import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginNativeRecording,
  currentNativeRecording,
  discardNativeRecording,
  invokeStopRecording,
  pauseNativeRecording,
  resetNativeRecordingSession,
  resumeNativeRecording,
  stopNativeRecording,
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
