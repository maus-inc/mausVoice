import { invoke } from "@tauri-apps/api/core";
import { createMutationQueue } from "./mutation-queue";
import { getLogger } from "./log.utils";

// The native values are process-global. Each setting has one ordered writer in
// the main renderer, so a slow earlier IPC cannot overwrite a newer preference.
const chimeWrites = createMutationQueue();
const volumeWrites = createMutationQueue();

export const syncInteractionChime = (enabled: boolean): Promise<void> =>
  chimeWrites
    .enqueue(() => invoke<void>("set_interaction_chime_enabled", { enabled }))
    .catch((error: unknown) => {
      getLogger().warning(
        "Failed to sync interaction chime to native audio",
        error,
      );
    });

export const syncInteractionFeedbackVolume = (volume: number): Promise<void> =>
  volumeWrites
    .enqueue(() => invoke<void>("set_interaction_feedback_volume", { volume }))
    .catch((error: unknown) => {
      getLogger().warning(
        "Failed to sync interaction volume to native audio",
        error,
      );
    });
