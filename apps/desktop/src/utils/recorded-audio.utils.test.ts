import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  decodeStopRecordingPayload,
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

  it("passes object payloads from the preview runtime through unchanged", () => {
    const payload = { samples: [0.1, 0.2], sampleRate: 16_000 };
    expect(decodeStopRecordingPayload(payload)).toBe(payload);
  });
});

describe("invokeStopRecording", () => {
  it("invokes stop_recording and decodes the response", async () => {
    const invokeFn = vi.fn(async () => encode(48_000, [0.5]));
    const decoded = await invokeStopRecording(invokeFn);
    expect(invokeFn).toHaveBeenCalledWith("stop_recording");
    expect(Array.from(decoded.samples)).toEqual([0.5]);
  });
});
