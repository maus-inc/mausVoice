import { listen, UnlistenFn } from "@tauri-apps/api/event";

type AudioChunkPayload = {
  samples: number[];
};

/** Subscribe to the recorder's live mono sample stream (~100 ms batches). */
export const listenToAudioChunks = (
  onSamples: (samples: number[]) => void,
): Promise<UnlistenFn> =>
  listen<AudioChunkPayload>("audio_chunk", (event) => {
    if (event.payload.samples.length > 0) {
      onSamples(event.payload.samples);
    }
  });
