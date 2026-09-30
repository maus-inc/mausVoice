import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";

const HEADER_BYTES = 4;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const decodeBinary = (bytes: Uint8Array): StopRecordingResponse => {
  if (bytes.byteLength < HEADER_BYTES) {
    return EMPTY_RESULT();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(0, true);
  const sampleCount = Math.floor((bytes.byteLength - HEADER_BYTES) / 4);
  const samplesOffset = bytes.byteOffset + HEADER_BYTES;
  if (IS_LITTLE_ENDIAN && samplesOffset % 4 === 0) {
    return {
      samples: new Float32Array(bytes.buffer, samplesOffset, sampleCount),
      sampleRate,
    };
  }
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(HEADER_BYTES + index * 4, true);
  }
  return { samples, sampleRate };
};

const EMPTY_RESULT = (): StopRecordingResponse => ({
  samples: new Float32Array(0),
  sampleRate: 0,
});

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
