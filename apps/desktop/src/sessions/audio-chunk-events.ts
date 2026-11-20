import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type AudioChunkAdmission = { ownerId: string; generation: number };

type AudioChunkPayload = {
  samples: number[];
  ownerId?: string;
  generation?: number;
  /** Index of the first sample in the recording. */
  offset?: number;
};

/** Subscribe to the recorder's live mono sample stream (~100 ms batches). */
export const listenToAudioChunks = (
  onSamples: (
    samples: number[],
    offset: number | null,
    admission: AudioChunkAdmission | null,
  ) => void,
): Promise<UnlistenFn> =>
  listen<AudioChunkPayload>("audio_chunk", (event) => {
    if (event.payload.samples.length > 0) {
      const { ownerId, generation } = event.payload;
      const admission =
        typeof ownerId === "string" &&
        ownerId.length > 0 &&
        typeof generation === "number" &&
        Number.isSafeInteger(generation) &&
        generation >= 0
          ? { ownerId, generation }
          : null;
      onSamples(event.payload.samples, event.payload.offset ?? null, admission);
    }
  });
