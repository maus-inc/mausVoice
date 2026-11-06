import type { StopRecordingResponse } from "../types/transcription-session.types";

const HEADER_BYTES = 4;

/**
 * The top bit of the sample-rate header means the capture failed partway
 * through and the samples are what was recorded before it did. Native sets it
 * in `encode_recording_result`; the rate itself never reaches this bit.
 */
const CAPTURE_FAILED_FLAG = 0x80000000;
const SAMPLE_RATE_MASK = 0x7fffffff;

const readCaptureFailed = (value: unknown): boolean =>
  value === true ||
  (typeof value === "number" && (value & CAPTURE_FAILED_FLAG) !== 0);
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const EMPTY_RESULT = (): StopRecordingResponse => ({
  samples: new Float32Array(0),
  sampleRate: 0,
});

/**
 * Encode audio for a raw-body IPC command as `[sampleRate u32 LE][f32 LE...]`.
 *
 * Mirrors the Rust `encode_recorded_audio` framing that `stop_recording`
 * returns, so one wire format describes a recording in both directions. The
 * alternative — a JSON number array — costs roughly four times the bytes and
 * the full `JSON.stringify`/parse of every sample, which for long dictations
 * is hundreds of milliseconds on the save path.
 */
export const encodeRecordedAudio = (
  samples: number[] | Float32Array,
  sampleRate: number,
  captureFailed = false,
): Uint8Array => {
  const sampleCount = samples.length;
  const bytes = new Uint8Array(HEADER_BYTES + sampleCount * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(
    0,
    captureFailed ? (sampleRate | CAPTURE_FAILED_FLAG) >>> 0 : sampleRate,
    true,
  );
  if (IS_LITTLE_ENDIAN) {
    // Aligned: the f32 view writes the platform's little-endian layout
    // directly, which is the wire layout. `set` copies rather than aliases,
    // so the caller's samples stay untouched.
    new Float32Array(bytes.buffer, HEADER_BYTES, sampleCount).set(samples);
    return bytes;
  }
  for (let index = 0; index < sampleCount; index += 1) {
    view.setFloat32(HEADER_BYTES + index * 4, samples[index] ?? 0, true);
  }
  return bytes;
};

const decodeBinary = (bytes: Uint8Array): StopRecordingResponse => {
  if (bytes.byteLength < HEADER_BYTES) {
    return EMPTY_RESULT();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint32(0, true);
  // Leaving the flag in the rate made a failed capture look like a recording
  // at an absurd rate, so every sample was resampled from a rate no device
  // reports and the failure was never surfaced.
  const sampleRate = header & SAMPLE_RATE_MASK;
  const captureFailure = (header & CAPTURE_FAILED_FLAG) !== 0;
  const sampleCount = Math.floor((bytes.byteLength - HEADER_BYTES) / 4);
  const samplesOffset = bytes.byteOffset + HEADER_BYTES;
  const failure = captureFailure ? { captureFailed: true } : {};
  if (IS_LITTLE_ENDIAN && samplesOffset % 4 === 0) {
    return {
      samples: new Float32Array(bytes.buffer, samplesOffset, sampleCount),
      sampleRate,
      ...failure,
    };
  }
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(HEADER_BYTES + index * 4, true);
  }
  return { samples, sampleRate, ...failure };
};

/**
 * Whether `value` can back a `Float32Array` without surprising the caller.
 *
 * A typed array or a plain array of real numbers can. `null`, a string, an
 * object, and a sparse array cannot: those reached `Float32Array.from` and
 * `.length` downstream and either threw or quietly produced a recording of
 * the wrong shape.
 */
const isSampleArray = (value: unknown): value is Float32Array | number[] =>
  ArrayBuffer.isView(value) || Array.isArray(value);

/**
 * Decode the `stop_recording` IPC body: `[sampleRate u32 LE][f32 LE...]`.
 *
 * Object payloads (browser preview runtime, test doubles) are accepted so every
 * caller shares one decoding path, but they are validated rather than cast. The
 * cast this replaces handed back whatever the object claimed to be, so a
 * payload shaped `{ samples: null }` came out of here as a
 * `StopRecordingResponse` whose `samples` was null, and the first
 * `outAudio.samples.length` then threw inside the caller's `try` -- which turned
 * a native stop that had already succeeded into "Failed to stop recording" and a
 * null audio result. A malformed body now decodes to empty, the same way an
 * unrecognised one always has.
 */
export const decodeStopRecordingPayload = (
  payload: unknown,
): StopRecordingResponse => {
  if (payload instanceof ArrayBuffer) {
    return decodeBinary(new Uint8Array(payload));
  }
  if (ArrayBuffer.isView(payload)) {
    return decodeBinary(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }
  if (Array.isArray(payload)) {
    return decodeBinary(Uint8Array.from(payload as number[]));
  }
  if (payload && typeof payload === "object" && "samples" in payload) {
    const { samples, sampleRate, captureFailed } = payload as {
      samples?: unknown;
      sampleRate?: unknown;
      captureFailed?: unknown;
    };
    if (!isSampleArray(samples)) {
      return EMPTY_RESULT();
    }
    return {
      // Copied rather than aliased: a caller that writes into the decoded
      // buffer must not be able to reach back into the payload it came from.
      samples:
        samples instanceof Float32Array
          ? samples.slice()
          : Float32Array.from(samples),
      sampleRate:
        typeof sampleRate === "number" && Number.isFinite(sampleRate)
          ? sampleRate
          : 0,
      ...(readCaptureFailed(captureFailed) ? { captureFailed: true } : {}),
    };
  }
  return EMPTY_RESULT();
};
