import { listen, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Payload of the `audio_chunk` event, emitted by
 * `src-tauri/src/domain/recording.rs::AudioChunkPayload`. Single-sourced here
 * so every listener of the event shares one contract; `offset` is required
 * because the native side always sends it.
 */
export type AudioChunkPayload = {
  samples: number[];
  /** Index of the first sample in the recording. */
  offset: number;
};

/** Subscribe to the recorder's live mono sample stream (~100 ms batches). */
export const listenToAudioChunks = (
  onSamples: (samples: number[], offset: number | null) => void,
): Promise<UnlistenFn> =>
  listen<AudioChunkPayload>("audio_chunk", (event) => {
    if (event.payload.samples.length > 0) {
      // The contract requires `offset`, but the webview bundle and the native
      // side can be on different builds. A chunk with no offset cannot be
      // aligned with the final recording, so report it as unalignable rather
      // than assuming it starts at zero.
      const { samples, offset } = event.payload;
      onSamples(samples, typeof offset === "number" ? offset : null);
    }
  });
