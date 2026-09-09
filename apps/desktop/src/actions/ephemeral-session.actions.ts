import { emit } from "@tauri-apps/api/event";
import {
  EPHEMERAL_SESSION_ENDED_EVENT,
  EPHEMERAL_SESSION_STARTED_EVENT,
  type EphemeralSessionEndedPayload,
  type EphemeralSessionStartedPayload,
} from "@maus-inc/desktop-utils";
import { produceAppState } from "../store";
import { isEphemeralSessionActive } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";

/**
 * Owns the run scoped ephemeral session only. The stored preference that offers
 * sessions to the user is the `ephemeralSessionEnabled` expansion flag, so
 * `setExpansionFlag` in `features/featureFlags.ts` toggles it and nothing here
 * writes to `user_preferences`.
 */
const setEphemeralSessionActive = async (active: boolean): Promise<void> => {
  if (isEphemeralSessionActive() === active) {
    return;
  }

  produceAppState((draft) => {
    draft.local.ephemeralSessionActive = active;
  });

  const at = new Date().toISOString();
  const eventName = active
    ? EPHEMERAL_SESSION_STARTED_EVENT
    : EPHEMERAL_SESSION_ENDED_EVENT;
  const payload: EphemeralSessionStartedPayload | EphemeralSessionEndedPayload =
    active ? { startedAt: at } : { endedAt: at };

  try {
    await emit(eventName, payload);
  } catch (error) {
    // State is already updated, so a failed broadcast must not wedge the
    // session. Other windows simply miss the notification.
    getLogger().error(`Failed to emit ${eventName}: ${error}`);
  }
};

/**
 * Start an ephemeral session. Persistence stays suppressed until the session
 * ends or the app closes.
 */
export const startEphemeralSession = (): Promise<void> =>
  setEphemeralSessionActive(true);

/**
 * End the current ephemeral session and allow persistence again.
 */
export const endEphemeralSession = (): Promise<void> =>
  setEphemeralSessionActive(false);
