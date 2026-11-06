import { listen, UnlistenFn } from "@tauri-apps/api/event";

type AudioChunkPayload = {
  samples: number[];
  ownerId?: string;
  generation?: number;
  /** Index of the first sample in the recording. */
  offset?: number;
};

type AcceptedChunk = { samples: number[]; offset: number | null };

/** A chunk belongs to this listener only when the owner and generation match. */
const belongsToThisRecording = (
  payload: AudioChunkPayload,
  ownerId: string | undefined,
  generation: number | null | undefined,
  checkGeneration: boolean,
): boolean => {
  if (ownerId !== undefined && payload.ownerId !== ownerId) return false;
  if (!checkGeneration) return true;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    return false;
  }
  if (payload.generation !== generation) return false;
  return true;
};

/** A usable sample offset, or `null` when the recorder did not index the chunk. */
const readChunkOffset = (payload: AudioChunkPayload): number | null =>
  Number.isSafeInteger(payload.offset) && (payload.offset as number) >= 0
    ? (payload.offset as number)
    : null;

/**
 * Accept only a chunk that belongs to the recording this listener owns. A stale
 * owner, a retired generation, or an empty batch is dropped rather than
 * forwarded into the live session.
 */
const acceptAudioChunk = (
  payload: AudioChunkPayload | null | undefined,
  ownerId: string | undefined,
  generation: number | null | undefined,
  checkGeneration: boolean,
): AcceptedChunk | null => {
  if (!payload || typeof payload !== "object") return null;
  if (!belongsToThisRecording(payload, ownerId, generation, checkGeneration)) {
    return null;
  }
  if (!Array.isArray(payload.samples) || payload.samples.length === 0) {
    return null;
  }
  return { samples: payload.samples, offset: readChunkOffset(payload) };
};

/** Subscribe to the recorder's live mono sample stream (~100 ms batches). */
export const listenToAudioChunks = (
  onSamples: (samples: number[], offset: number | null) => void,
  ownerId?: string,
  getGeneration?: () => number | null,
): Promise<UnlistenFn> =>
  listen<AudioChunkPayload>("audio_chunk", (event) => {
    const chunk = acceptAudioChunk(
      event.payload,
      ownerId,
      getGeneration?.(),
      getGeneration !== undefined,
    );
    if (!chunk) return;
    onSamples(chunk.samples, chunk.offset);
  });
