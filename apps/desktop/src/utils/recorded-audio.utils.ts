import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";

const HEADER_BYTES = 4;
/**
 * The trailer the Rust stop path appends only when the capture faulted:
 * `[duration_ms: u32 LE][expected_ms: u32 LE][flags: u32 LE][magic: u32 LE]`.
 *
 * Its presence cannot be inferred from the audio. A float32 stream is always a
 * multiple of four bytes, so twelve bytes of trailer look exactly like three
 * samples, and an earlier version of this decoder keyed off a single flag bit —
 * which is the low bit of the last sample's IEEE-754 mantissa, set for
 * essentially all real audio. That version reported a capture fault and dropped
 * three samples on about half of all healthy recordings.
 *
 * The magic is the discriminator because it is the one word that cannot plausibly
 * be part of a recording, so the trailer is only consumed when it matches.
 */
const TRAILER_BYTES = 16;
const CAPTURE_FAULT_BIT = 0b1;
/**
 * `CAPTURE_TRAILER_MAGIC` in `commands.rs`, byte for byte: the ASCII bytes
 * `C`, `A`, `P`, `T`.
 *
 * Grouped in pairs because a pair is one character of the word, which is the
 * unit that makes the number readable. A separator every four digits would
 * split the word down the middle and group for the sake of grouping.
 */
// prettier-ignore
const CAPTURE_TRAILER_MAGIC = 0x43_41_50_54;
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
  if (byteLength < HEADER_BYTES + TRAILER_BYTES) {
    // Too short to hold a trailer plus its header: an untrusted tail word must
    // not cost a real recording any samples.
    return null;
  }
  if (view.getUint32(byteLength - 4, true) !== CAPTURE_TRAILER_MAGIC) {
    return null;
  }
  const flags = view.getUint32(byteLength - 8, true);
  if ((flags & CAPTURE_FAULT_BIT) === 0) {
    // A magic without the flag is not a trailer this build wrote. The audio is
    // kept and the fault is not reported, which is the safe direction.
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
/**
 * Reads the finite number, or falls back to zero.
 *
 * `typeof === "number"` alone admits `NaN` and `Infinity`, and a non-finite
 * sample rate propagates into every duration the caller computes from it.
 */
const finiteOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Decodes the `{ samples, sampleRate, ... }` object shape of the stop payload.
 *
 * The capture facts are carried across too. This exists so every caller shares
 * one decoding path, and returning only the audio meant the path that most needs
 * the fault -- the preview runtime and the test doubles -- was the one path
 * where a faulted capture reported nothing at all.
 */
const decodeObjectPayload = (fields: {
  samples: unknown;
  sampleRate: unknown;
  captureFault: unknown;
  capturedMs: unknown;
  expectedMs: unknown;
}): StopRecordingResponse => {
  const { samples, sampleRate, captureFault, capturedMs, expectedMs } = fields;
  if (!isSampleArray(samples)) {
    return EMPTY_RESULT();
  }
  return {
    // Copied rather than aliased: a caller that writes into the decoded buffer
    // must not be able to reach back into the payload it came from.
    samples:
      samples instanceof Float32Array
        ? samples.slice()
        : Float32Array.from(samples),
    sampleRate: finiteOrZero(sampleRate),
    // Only a fatal fault is reported; anything else is silence, which is what
    // an older caller already assumed.
    ...(captureFault === "fatal" ? { captureFault: "fatal" as const } : {}),
    ...(typeof capturedMs === "number" && Number.isFinite(capturedMs)
      ? { capturedMs }
      : {}),
    ...(typeof expectedMs === "number" && Number.isFinite(expectedMs)
      ? { expectedMs }
      : {}),
  };
};

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
    const { samples, sampleRate, captureFault, capturedMs, expectedMs } =
      payload as {
        samples?: unknown;
        sampleRate?: unknown;
        captureFault?: unknown;
        capturedMs?: unknown;
        expectedMs?: unknown;
      };
    return decodeObjectPayload({
      samples,
      sampleRate,
      captureFault,
      capturedMs,
      expectedMs,
    });
  }
  return EMPTY_RESULT();
};

export const invokeStopRecording = async (
  invokeFn: (command: string) => Promise<unknown> = invoke,
): Promise<StopRecordingResponse> =>
  decodeStopRecordingPayload(await invokeFn("stop_recording"));
