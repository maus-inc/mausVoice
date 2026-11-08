import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";

const HEADER_BYTES = 4;
/**
 * The trailer the Rust stop path appends only when the capture faulted.
 *
 * `[duration_ms: u32 LE][expected_ms: u32 LE][flags: u32 LE]`. Its presence is
 * not length-delimited in a way a decoder can infer from the audio alone — a
 * float32 stream is always a multiple of four bytes, so twelve bytes without a
 * marker is indistinguishable from three samples — and the flags word is the only
 * thing that says so. The flag is therefore read from the end of the body first,
 * and the trailer only consumed once it is recognised as ours.
 *
 * This matters more than it looks: reading the trailer optimistically would
 * silently drop the last 12 bytes of every ordinary recording, which on a 48 kHz
 * dictation is the last third of a millisecond and on a short one is the whole
 * recording.
 */
const TRAILER_BYTES = 12;
const CAPTURE_FAULT_BIT = 1 << 0;
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
): Uint8Array => {
  const sampleCount = samples.length;
  const bytes = new Uint8Array(HEADER_BYTES + sampleCount * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, sampleRate, true);
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

/**
 * The capture facts a faulted recording carries, if any.
 *
 * Returns `null` for every ordinary recording: the trailer is only read once its
 * flags word is recognised, so an untrailed body keeps every byte of audio.
 */
const readCaptureTrailer = (
  view: DataView,
  byteLength: number,
): { durationMs: number; expectedMs: number } | null => {
  if (byteLength < HEADER_BYTES + 4) {
    return null;
  }
  const flags = view.getUint32(byteLength - 4, true);
  if ((flags & CAPTURE_FAULT_BIT) === 0) {
    return null;
  }
  if (byteLength < HEADER_BYTES + TRAILER_BYTES) {
    // A flags word without room for the trailer cannot be trusted: the body is
    // shorter than the header it claims. Treated as untrailed, so the audio is
    // kept and the fault is simply not reported.
    return null;
  }
  return {
    durationMs: view.getUint32(byteLength - TRAILER_BYTES, true),
    expectedMs: view.getUint32(byteLength - TRAILER_BYTES + 4, true),
  };
};

const decodeBinary = (bytes: Uint8Array): StopRecordingResponse => {
  if (bytes.byteLength < HEADER_BYTES) {
    return EMPTY_RESULT();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(0, true);
  const trailer = readCaptureTrailer(view, bytes.byteLength);
  const audioBytes = trailer
    ? bytes.byteLength - TRAILER_BYTES
    : bytes.byteLength;
  const sampleCount = Math.floor((audioBytes - HEADER_BYTES) / 4);
  const samplesOffset = bytes.byteOffset + HEADER_BYTES;
  const capture = trailer
    ? {
        captureFault: "fatal" as const,
        capturedMs: trailer.durationMs,
        expectedMs: trailer.expectedMs,
      }
    : {};
  if (IS_LITTLE_ENDIAN && samplesOffset % 4 === 0) {
    return {
      samples: new Float32Array(bytes.buffer, samplesOffset, sampleCount),
      sampleRate,
      ...capture,
    };
  }
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(HEADER_BYTES + index * 4, true);
  }
  return { samples, sampleRate, ...capture };
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
    const { samples, sampleRate } = payload as {
      samples?: unknown;
      sampleRate?: unknown;
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
    };
  }
  return EMPTY_RESULT();
};

export const invokeStopRecording = async (
  invokeFn: (command: string) => Promise<unknown> = invoke,
): Promise<StopRecordingResponse> =>
  decodeStopRecordingPayload(await invokeFn("stop_recording"));
