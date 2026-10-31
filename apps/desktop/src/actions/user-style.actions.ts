import { Nullable, StylingMode } from "@maus-inc/types";
import { getAppState, produceAppState } from "../store";
import { getMyEffectiveUserId } from "../utils/user.utils";
import { getActiveManualToneIds, getSortedToneIds } from "../utils/tone.utils";
import { setLocalStorageValue } from "./local-storage.actions";

import { updateUser } from "./user-actions-core";

export const setStylingMode = async (
  mode: Nullable<StylingMode>,
): Promise<void> => {
  await updateUser(
    (user) => {
      user.stylingMode = mode;
    },
    "Unable to set styling mode. User not found.",
    "Failed to save styling mode preference. Please try again.",
  );
};

export const setActiveToneIds = async (toneIds: string[]): Promise<void> => {
  await updateUser(
    (user) => {
      user.activeToneIds = toneIds;
    },
    "Unable to update active styles. User not found.",
    "Failed to update active styles. Please try again.",
  );
};

/** Apply the user's toggle intent when it reaches the shared user queue. */
export const toggleActiveTone = (toneId: string): Promise<void> =>
  updateUser(
    (user) => {
      const state = getAppState();
      if (!state.toneById[toneId]) return;
      const active = new Set(getActiveManualToneIds(state));
      if (active.has(toneId)) {
        if (active.size <= 1) return;
        active.delete(toneId);
      } else {
        active.add(toneId);
      }
      user.activeToneIds = getSortedToneIds(state).filter((id) =>
        active.has(id),
      );
    },
    "Unable to update active styles. User not found.",
    "Failed to update active styles. Please try again.",
  );

export const setSelectedToneId = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      user.selectedToneId = toneId;
    },
    "Unable to select style. User not found.",
    "Failed to select style. Please try again.",
  );
  setLocalStorageValue("mausvoice:checklist-writing-style", true);
};

export const activateAndSelectTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const currentIds = user.activeToneIds ?? [];
      if (!currentIds.includes(toneId)) {
        user.activeToneIds = [toneId, ...currentIds];
      }
      user.selectedToneId = toneId;
    },
    "Unable to activate style. User not found.",
    "Failed to activate style. Please try again.",
  );
};

export const deselectActiveTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const current = user.activeToneIds ?? [];
      user.activeToneIds = current.filter((id) => id !== toneId);
    },
    "Unable to deselect style. User not found.",
    "Failed to deselect style. Please try again.",
  );
};

export const markUpgradeDialogSeen = async (): Promise<void> => {
  await updateUser(
    (user) => {
      user.shouldShowUpgradeDialog = false;
    },
    "Unable to mark upgrade dialog as seen. User not found.",
    "Failed to mark upgrade dialog as seen. Please try again.",
  );
};

/**
 * Store or clear the profile photo for the current user.
 *
 * Local state only, so this is synchronous and needs no error handling: the
 * alternative would be an account-image column and a round trip to the local
 * database for something that never leaves the device. Passing null removes the
 * photo, which is how the editor's "Remove photo" is expressed.
 */
export const setMyProfileImage = (dataUrl: Nullable<string>): void => {
  const userId = getMyEffectiveUserId(getAppState());
  produceAppState((draft) => {
    if (dataUrl) {
      draft.local.profileImageByUserId[userId] = dataUrl;
    } else {
      // `delete` is the idiomatic Immer draft operation and matches the rest of
      // the codebase. DeepSource JS-0320 flags the dynamic key, but the removal
      // is intentional and the key is a user id this app generated.
      delete draft.local.profileImageByUserId[userId]; // skipcq: JS-0320
    }
  });
};
