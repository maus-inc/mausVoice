import {
  type LocalDataWriteLease,
  withRequiredLocalDataWriteSync,
} from "../utils/local-data-write-gate";
import { Nullable, StylingMode } from "@maus-inc/types";
import { getIntl } from "../i18n";
import { getAppState, produceAppState } from "../store";
import { getMyEffectiveUserId } from "../utils/user.utils";
import { getActiveManualToneIds, getSortedToneIds } from "../utils/tone.utils";
import { setLocalStorageValue } from "./local-storage.actions";
import { updateUser } from "./user-actions-core";

export const setStylingMode = async (
  mode: Nullable<StylingMode>,
): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.stylingMode = mode;
    },
    intl.formatMessage({
      defaultMessage: "Unable to set styling mode. User not found.",
    }),
    intl.formatMessage({
      defaultMessage:
        "Failed to save styling mode preference. Please try again.",
    }),
  );
};

export const setActiveToneIds = async (toneIds: string[]): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.activeToneIds = toneIds;
    },
    intl.formatMessage({
      defaultMessage: "Unable to update active styles. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to update active styles. Please try again.",
    }),
  );
};

/** Apply the user's toggle intent when it reaches the shared user queue. */
export const toggleActiveTone = (toneId: string): Promise<void> => {
  const intl = getIntl();
  return updateUser(
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
    intl.formatMessage({
      defaultMessage: "Unable to update active styles. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to update active styles. Please try again.",
    }),
  );
};

export const setSelectedToneId = async (
  toneId: string | null,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.selectedToneId = toneId;
    },
    intl.formatMessage({
      defaultMessage: "Unable to select style. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to select style. Please try again.",
    }),
    lease,
  );
  setLocalStorageValue("mausvoice:checklist-writing-style", true, lease);
};

export const activateAndSelectTone = async (
  toneId: string,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      const currentIds = user.activeToneIds ?? [];
      if (!currentIds.includes(toneId)) {
        user.activeToneIds = [toneId, ...currentIds];
      }
      user.selectedToneId = toneId;
    },
    intl.formatMessage({
      defaultMessage: "Unable to activate style. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to activate style. Please try again.",
    }),
    lease,
  );
};

export const deselectActiveTone = async (
  toneId: string,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      const current = user.activeToneIds ?? [];
      user.activeToneIds = current.filter((id) => id !== toneId);
    },
    intl.formatMessage({
      defaultMessage: "Unable to deselect style. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to deselect style. Please try again.",
    }),
    lease,
  );
};

export const markUpgradeDialogSeen = async (): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.shouldShowUpgradeDialog = false;
    },
    intl.formatMessage({
      defaultMessage: "Unable to mark upgrade dialog as seen. User not found.",
    }),
    intl.formatMessage({
      defaultMessage:
        "Failed to mark upgrade dialog as seen. Please try again.",
    }),
  );
};

/**
 * Store or clear the profile photo for the current user.
 *
 * Local state only, guarded by the local-data write gate so an edit attempted
 * while local data is clearing rejects instead of mutating memory without
 * persisting. Passing null removes the photo.
 */
export const setMyProfileImage = (dataUrl: Nullable<string>): void => {
  withRequiredLocalDataWriteSync((lease) => {
    const userId = getMyEffectiveUserId(getAppState());
    produceAppState((draft) => {
      if (dataUrl) {
        draft.local.profileImageByUserId[userId] = dataUrl;
      } else {
        // `delete` is the idiomatic Immer draft operation and matches the rest
        // of the codebase. DeepSource JS-0320 flags the dynamic key, but the
        // removal is intentional and the key is a user id this app generated.
        delete draft.local.profileImageByUserId[userId]; // skipcq: JS-0320
      }
    }, lease);
  });
};
