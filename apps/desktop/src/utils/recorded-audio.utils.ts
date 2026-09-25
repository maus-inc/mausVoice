import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";

const HEADER_BYTES = 4;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const decodeBinary = (bytes: Uint8Array): StopRecordingResponse => {
  if (bytes.byteLength < HEADER_BYTES) {
    return { samples: new Float32Array(0), sampleRate: 0 };
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

/**
 * Decode the `stop_recording` IPC body: `[sampleRate u32 LE][f32 LE...]`.
 * Object payloads (browser preview runtime, test doubles) pass through so
 * every caller shares one decoding path.
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
    return payload as StopRecordingResponse;
  }
  return { samples: new Float32Array(0), sampleRate: 0 };
};

export const invokeStopRecording = async (
  invokeFn: (command: string) => Promise<unknown> = invoke,
): Promise<StopRecordingResponse> =>
  decodeStopRecordingPayload(await invokeFn("stop_recording"));
