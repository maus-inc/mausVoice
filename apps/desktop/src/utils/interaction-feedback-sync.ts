import { invoke } from "@tauri-apps/api/core";
import { createMutationQueue } from "./mutation-queue";

// The native values are process-global. Each setting has one ordered writer in
// the main renderer, so a slow earlier IPC cannot overwrite a newer preference.
const chimeWrites = createMutationQueue();
const volumeWrites = createMutationQueue();

export const syncInteractionChime = (enabled: boolean): Promise<void> =>
  chimeWrites.enqueue(() =>
    invoke<void>("set_interaction_chime_enabled", { enabled }),
  );

export const syncInteractionFeedbackVolume = (volume: number): Promise<void> =>
  volumeWrites.enqueue(() =>
    invoke<void>("set_interaction_feedback_volume", { volume }),
  );
