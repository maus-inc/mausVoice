import type { StopRecordingResponse } from "../types/transcription-session.types";
import { hasFiniteAudioSamples } from "./audio-samples.utils";

const HEADER_BYTES = 4;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const EMPTY_RESULT = (): StopRecordingResponse => ({
  samples: new Float32Array(0),
  sampleRate: 0,
});

const decodeBinary = (bytes: Uint8Array): StopRecordingResponse | null => {
  if (
    bytes.byteLength < HEADER_BYTES ||
    (bytes.byteLength - HEADER_BYTES) % 4 !== 0
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint32(0, true);
  const captureFailed = (header & 0x80000000) !== 0;
  const sampleRate = header & 0x7fffffff;
  const sampleCount = Math.floor((bytes.byteLength - HEADER_BYTES) / 4);
  const samplesOffset = bytes.byteOffset + HEADER_BYTES;
  const alignedNative = IS_LITTLE_ENDIAN && samplesOffset % 4 === 0;
  const samples = alignedNative
    ? new Float32Array(bytes.buffer, samplesOffset, sampleCount)
    : new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    if (!alignedNative) {
      samples[index] = view.getFloat32(HEADER_BYTES + index * 4, true);
    }
    if (!Number.isFinite(samples[index])) return null;
  }
  return {
    samples,
    sampleRate,
    ...(captureFailed ? { captureFailed: true } : {}),
  };
};

const decodeByteArray = (bytes: unknown[]): StopRecordingResponse | null => {
  for (const byte of bytes) {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      return null;
    }
  }
  return decodeBinary(Uint8Array.from(bytes as number[]));
};

/**
 * Whether `value` can back a `Float32Array` without surprising the caller.
 *
 * A typed array or a plain array of real numbers can. `null`, a string, an
 * object, and a sparse array cannot: those reached `Float32Array.from` and
 * `.length` downstream and either threw or quietly produced a recording of
 * the wrong shape.
 */
const isSampleArray = (value: unknown): value is ArrayLike<number> => {
  if (
    !Array.isArray(value) &&
    (!ArrayBuffer.isView(value) || value instanceof DataView)
  ) {
    return false;
  }
  const samples = value as ArrayLike<number>;
  if (!Number.isSafeInteger(samples.length) || samples.length < 0) return false;
  return hasFiniteAudioSamples(samples);
};

/** The buffered forms a native reply can arrive in, or `null` for the rest. */
const payloadBytes = (payload: unknown): Uint8Array | null => {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
  }
  return null;
};

/** `null` rejects the body, `false` means the flag was absent. */
const readCaptureFailedFlag = (value: unknown): boolean | null => {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
};

/**
 * One caller needs a usable rate, the legacy one tolerates a zero. `null` means
 * the rate was required and is unusable.
 */
const readSampleRate = (value: unknown, required: boolean): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return required ? null : 0;
};

/**
 * Object payloads (browser preview runtime, test doubles) are accepted so every
 * caller shares one decoding path, but they are validated rather than cast. The
 * cast this replaces handed back whatever the object claimed to be, so a
 * payload shaped `{ samples: null }` came out of here as a
 * `StopRecordingResponse` whose `samples` was null, and the first
 * `outAudio.samples.length` then threw inside the caller's `try` -- which turned
 * a native stop that had already succeeded into "Failed to stop recording" and a
 * null audio result. `null` here rejects the body instead.
 */
const decodeStopRecordingObject = (
  payload: unknown,
  requireSampleRate: boolean,
): StopRecordingResponse | null => {
  if (!payload || typeof payload !== "object" || !("samples" in payload)) {
    return null;
  }
  const { samples, sampleRate, captureFailed } = payload as {
    samples?: unknown;
    sampleRate?: unknown;
    captureFailed?: unknown;
  };
  const failed = readCaptureFailedFlag(captureFailed);
  if (failed === null) return null;
  if (!isSampleArray(samples)) return null;
  const rate = readSampleRate(sampleRate, requireSampleRate);
  if (rate === null) return null;
  return {
    // Copied rather than aliased: a caller that writes into the decoded
    // buffer must not be able to reach back into the payload it came from.
    samples:
      samples instanceof Float32Array
        ? samples.slice()
        : Float32Array.from(samples),
    sampleRate: rate,
    ...(failed ? { captureFailed: true } : {}),
  };
};

/**
 * Decode the `stop_recording` IPC body, which is
 * `[sampleRate u32 LE][f32 LE...]` or one of the object forms above. The rate's
 * high bit marks failed capture, whose samples are only a partial recording
 * suitable for recovery. `null` means the body is malformed, so a caller that
 * must not acknowledge a stop reply can tell that apart from an empty one.
 */
const decodeStopRecordingPayloadInternal = (
  payload: unknown,
  requireSampleRate: boolean,
): StopRecordingResponse | null => {
  const bytes = payloadBytes(payload);
  if (bytes) return decodeBinary(bytes);
  if (Array.isArray(payload)) return decodeByteArray(payload);
  return decodeStopRecordingObject(payload, requireSampleRate);
};

export const tryDecodeStopRecordingPayload = (
  payload: unknown,
): StopRecordingResponse | null =>
  decodeStopRecordingPayloadInternal(payload, true);

export const decodeStopRecordingPayload = (
  payload: unknown,
): StopRecordingResponse =>
  decodeStopRecordingPayloadInternal(payload, false) ?? EMPTY_RESULT();
