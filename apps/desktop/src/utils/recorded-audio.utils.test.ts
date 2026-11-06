import { describe, expect, it } from "vitest";
import {
  decodeStopRecordingPayload,
  tryDecodeStopRecordingPayload,
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
  it("distinguishes an empty recording from an invalid stop reply", () => {
    expect(tryDecodeStopRecordingPayload(encode(0, []))).toEqual({
      samples: new Float32Array(0),
      sampleRate: 0,
    });
    expect(tryDecodeStopRecordingPayload(new ArrayBuffer(2))).toBeNull();
    expect(tryDecodeStopRecordingPayload(null)).toBeNull();
    expect(tryDecodeStopRecordingPayload({ samples: [] })).toBeNull();
    expect(tryDecodeStopRecordingPayload(encode(16000, [NaN]))).toBeNull();
  });

  it("decodes the raw [rate u32][f32...] IPC body", () => {
    const decoded = decodeStopRecordingPayload(encode(48_000, [0.5, -0.25, 1]));
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.samples).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded.samples)).toEqual([0.5, -0.25, 1]);
  });

  it("marks a partial capture while preserving its samples and rate", () => {
    const decoded = decodeStopRecordingPayload(
      encode(0x80000000 + 16000, [0.5]),
    );
    expect(decoded).toEqual({
      samples: new Float32Array([0.5]),
      sampleRate: 16000,
      captureFailed: true,
    });
    expect(
      decodeStopRecordingPayload({
        samples: [0.5],
        sampleRate: 16000,
        captureFailed: true,
      }),
    ).toEqual(decoded);
    expect(
      decodeStopRecordingPayload({
        samples: [0.5],
        sampleRate: 16000,
        captureFailed: "false",
      }).samples,
    ).toHaveLength(0);
  });

  it("decodes a byte view that starts at an unaligned offset", () => {
    const body = new Uint8Array(encode(16_000, [0.125, -0.5]));
    const padded = new Uint8Array(body.byteLength + 1);
    padded.set(body, 1);
    const decoded = decodeStopRecordingPayload(padded.subarray(1));
    expect(decoded.sampleRate).toBe(16_000);
    expect(Array.from(decoded.samples)).toEqual([0.125, -0.5]);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects a non-finite binary sample (%s) in aligned and unaligned views",
    (sample) => {
      const binary = new Uint8Array(encode(16000, [0.1, sample]));
      const unaligned = new Uint8Array(binary.length + 1);
      unaligned.set(binary, 1);
      for (const payload of [
        binary,
        unaligned.subarray(1),
        Array.from(binary),
      ]) {
        expect(decodeStopRecordingPayload(payload)).toEqual({
          samples: new Float32Array(0),
          sampleRate: 0,
        });
      }
    },
  );

  it.each([1, 2, 3])(
    "rejects a binary body with %s trailing bytes",
    (extra) => {
      const binary = new Uint8Array(encode(16000, [0.5]));
      const truncated = new Uint8Array(binary.length + extra);
      truncated.set(binary);
      expect(decodeStopRecordingPayload(truncated)).toEqual({
        samples: new Float32Array(0),
        sampleRate: 0,
      });
    },
  );

  it("decodes a number[] byte array from a JSON IPC fallback", () => {
    const bytes = Array.from(new Uint8Array(encode(44_100, [0.75])));
    const decoded = decodeStopRecordingPayload(bytes);
    expect(decoded.sampleRate).toBe(44_100);
    expect(Array.from(decoded.samples)).toEqual([0.75]);
  });

  it.each([
    ["BigInt", [1n]],
    ["a sparse array", Object.assign(Array(4), { 0: 128, 1: 62, 3: 0 })],
    ["a string", [128, 62, 0, "0"]],
    ["a value outside the byte range", [128, 62, 0, 256]],
    ["a fractional byte", [128, 62, 0, 0.5]],
  ])("rejects malformed byte arrays containing %s", (_label, payload) => {
    expect(decodeStopRecordingPayload(payload)).toEqual({
      samples: new Float32Array(0),
      sampleRate: 0,
    });
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

  it("decodes numeric typed-array samples", () => {
    const decoded = decodeStopRecordingPayload({
      samples: new Int16Array([1, -2]),
      sampleRate: 16_000,
    });
    expect(Array.from(decoded.samples)).toEqual([1, -2]);
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
    ["a DataView", new DataView(new ArrayBuffer(8))],
    ["a BigInt typed array", new BigInt64Array([1n])],
    ["an array with a string", [0.1, "0.2"]],
    ["a sparse array", Array(2)],
    ["an array with NaN", [Number.NaN]],
    ["a finite value outside the f32 range", [1e300]],
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
