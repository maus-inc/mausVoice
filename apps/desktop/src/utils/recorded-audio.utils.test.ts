import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  decodeStopRecordingPayload,
  encodeRecordedAudio,
  invokeStopRecording,
} from "./recorded-audio.utils";

const encode = (sampleRate: number, samples: number[]): ArrayBuffer => {
  const buffer = new ArrayBuffer(4 + samples.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, sampleRate, true);
  samples.forEach((sample, index) =>
    view.setFloat32(4 + index * 4, sample, true),
  );
  return buffer;
};

describe("decodeStopRecordingPayload", () => {
  it("decodes the raw [rate u32][f32...] IPC body", () => {
    const decoded = decodeStopRecordingPayload(encode(48_000, [0.5, -0.25, 1]));
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.samples).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.25, 1]);
  });

  it("decodes a byte view that starts at an unaligned offset", () => {
    const body = new Uint8Array(encode(16_000, [0.125, -0.5]));
    const padded = new Uint8Array(body.byteLength + 1);
    padded.set(body, 1);
    const decoded = decodeStopRecordingPayload(padded.subarray(1));
    expect(decoded.sampleRate).toBe(16_000);
    expect(Array.from(decoded.samples)).toEqual([0.125, -0.5]);
  });

  it("decodes a number[] byte array from a JSON IPC fallback", () => {
    const bytes = Array.from(new Uint8Array(encode(44_100, [0.75])));
    const decoded = decodeStopRecordingPayload(bytes);
    expect(decoded.sampleRate).toBe(44_100);
    expect(Array.from(decoded.samples)).toEqual([0.75]);
  });

  it("returns an empty recording for the not-recording header and junk", () => {
    expect(decodeStopRecordingPayload(encode(0, []))).toEqual({
      samples: new Float32Array(0),
      sampleRate: 0,
    });
    expect(decodeStopRecordingPayload(null).samples).toHaveLength(0);
    expect(decodeStopRecordingPayload(new ArrayBuffer(2)).sampleRate).toBe(0);
  });

  it("decodes object payloads from the preview runtime", () => {
    const payload = { samples: [0.1, 0.2], sampleRate: 16_000 };
    const decoded = decodeStopRecordingPayload(payload);
    // Compared against f32-rounded values, because the decoder returns a
    // Float32Array and 0.1 is not representable in one.
    expect(Array.from(decoded.samples)).toEqual(
      Array.from(new Float32Array([0.1, 0.2])),
    );
    expect(decoded.sampleRate).toBe(16_000);
  });

  it("copies a Float32Array so the caller cannot write back into the payload", () => {
    const samples = new Float32Array([0.5]);
    const decoded = decodeStopRecordingPayload({ samples, sampleRate: 16_000 });
    decoded.samples[0] = 99;
    expect(samples[0]).toBe(0.5);
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 7],
    ["a plain object", {}],
    // Array-like but not an array: `Float32Array.from` would have produced
    // `[NaN, NaN]` here, which is a recording of the wrong shape rather than an
    // obvious failure.
    ["an array-like object", { length: 2 }],
  ])("rejects a samples field that is %s", (_label, samples) => {
    // `{ samples: null }` is the shape that mattered: the decoder used to cast
    // any object with a `samples` key, so this came back typed as a recording
    // with null samples, and the first `.length` on it threw inside the stop
    // handler's try block. A native stop that had already succeeded became
    // "Failed to stop recording" and a null audio result.
    const decoded = decodeStopRecordingPayload({ samples, sampleRate: 16_000 });
    expect(decoded.samples).toHaveLength(0);
    expect(decoded.sampleRate).toBe(0);
  });

  it.each([
    ["a missing sampleRate", { samples: [0.1] }],
    ["a string sampleRate", { samples: [0.1], sampleRate: "16000" }],
    ["NaN", { samples: [0.1], sampleRate: Number.NaN }],
  ])("decodes to an empty recording for %s", (_label, payload) => {
    const decoded = decodeStopRecordingPayload(payload);
    expect(decoded.sampleRate).toBe(0);
    expect(Array.from(decoded.samples)).toEqual(
      Array.from(new Float32Array([0.1])),
    );
  });
});

describe("invokeStopRecording", () => {
  it("invokes stop_recording and decodes the response", async () => {
    const invokeFn = vi.fn(() => Promise.resolve(encode(48_000, [0.5])));
    const decoded = await invokeStopRecording(invokeFn);
    expect(invokeFn).toHaveBeenCalledWith("stop_recording");
    expect(Array.from(decoded.samples)).toEqual([0.5]);
  });
});

describe("encodeRecordedAudio", () => {
  it("round-trips through the decoder used by stop_recording", () => {
    const decoded = decodeStopRecordingPayload(
      encodeRecordedAudio(new Float32Array([0.5, -0.25, 1]), 48_000),
    );
    expect(decoded.sampleRate).toBe(48_000);
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.25, 1]);
  });

  it("accepts a plain number[] the store path can hold", () => {
    const decoded = decodeStopRecordingPayload(
      encodeRecordedAudio([0.125, -0.5], 16_000),
    );
    expect(decoded.sampleRate).toBe(16_000);
    expect(Array.from(decoded.samples)).toEqual([0.125, -0.5]);
  });

  it("encodes an empty recording as the bare header", () => {
    const bytes = encodeRecordedAudio(new Float32Array(0), 16_000);
    expect(bytes.byteLength).toBe(4);
    const decoded = decodeStopRecordingPayload(bytes);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples).toHaveLength(0);
  });

  it("does not write into the caller's samples", () => {
    const samples = new Float32Array([0.5]);
    encodeRecordedAudio(samples, 16_000);
    expect(samples[0]).toBe(0.5);
  });
});

describe("a capture that faulted mid-recording", () => {
  /** The body the Rust stop path produces for a faulted capture. */
  const encodeWithTrailer = (
    sampleRate: number,
    samples: number[],
    capturedMs: number,
    expectedMs: number,
  ): ArrayBuffer => {
    const buffer = new ArrayBuffer(4 + samples.length * 4 + 12);
    const view = new DataView(buffer);
    view.setUint32(0, sampleRate, true);
    samples.forEach((sample, index) =>
      view.setFloat32(4 + index * 4, sample, true),
    );
    const trailer = 4 + samples.length * 4;
    view.setUint32(trailer, capturedMs, true);
    view.setUint32(trailer + 4, expectedMs, true);
    view.setUint32(trailer + 8, 1, true);
    return buffer;
  };

  it("reports the fault and both lengths", () => {
    const decoded = decodeStopRecordingPayload(
      encodeWithTrailer(16_000, [0.5, -0.5], 1_400, 6_000),
    );

    expect(decoded.captureFault).toBe("fatal");
    expect(decoded.capturedMs).toBe(1_400);
    expect(decoded.expectedMs).toBe(6_000);
  });

  it("keeps every sample and none of the trailer as audio", () => {
    const decoded = decodeStopRecordingPayload(
      encodeWithTrailer(16_000, [0.5, -0.5], 1_400, 6_000),
    );

    // Reading the trailer without excising it would hand the last 12 bytes to
    // the decoder as three samples of noise.
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.5]);
  });

  it("leaves an ordinary recording with no trailer and no fault", () => {
    const decoded = decodeStopRecordingPayload(encode(48_000, [0.5, -0.25]));

    // The flag is what distinguishes them; a body whose last word happens to be
    // a sample value must not be read as a trailer.
    expect(decoded.captureFault).toBeUndefined();
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.25]);
    expect(decoded.samples).toHaveLength(2);
  });

  it("does not mistake ordinary audio for a trailer", () => {
    // A last sample whose bit pattern equals the fault flag, with no trailer
    // behind it. This is the case that makes the flag check insufficient on its
    // own, so the trailer is only read when there are bytes for it.
    const buffer = new ArrayBuffer(4 + 4);
    const view = new DataView(buffer);
    view.setUint32(0, 48_000, true);
    view.setUint32(4, 1, true);

    const decoded = decodeStopRecordingPayload(buffer);

    expect(decoded.captureFault).toBeUndefined();
    expect(decoded.samples).toHaveLength(1);
  });

  it("keeps the audio when a flags word has no room for its trailer", () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 48_000, true);
    view.setUint32(4, 1, true);

    const decoded = decodeStopRecordingPayload(buffer);

    // A body too short to hold the trailer it claims is untrusted: the fault is
    // dropped rather than a sample being sliced off a real recording.
    expect(decoded.captureFault).toBeUndefined();
  });

  it("carries the fault through the invoke wrapper", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(
      encodeWithTrailer(16_000, [0.25], 900, 3_000),
    );

    const decoded = await invokeStopRecording();

    expect(decoded.captureFault).toBe("fatal");
    expect(decoded.expectedMs).toBe(3_000);
  });
});
