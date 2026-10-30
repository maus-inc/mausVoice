import { Tone } from "@maus-inc/types";
import { getIntl } from "../i18n/intl";
import { getToneRepo } from "../repos";
import { ToneEditorMode } from "../state/tone-editor.state";
import { getAppState, produceAppState } from "../store";
import { registerTones } from "../utils/app.utils";
import { getLogger } from "../utils/log.utils";
import {
  toWritingStyleTransition,
  type WritingStyleSwitchRequest,
} from "../utils/dictation-style.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
} from "../utils/tone.utils";
import { getMyUser } from "../utils/user.utils";
import {
  type LocalDataWriteLease,
  beginLocalDataWrite,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { showErrorSnackbar, showSnackbar } from "./app.actions";
import { showToast } from "./toast.actions";
import {
  activateAndSelectTone,
  setSelectedToneId,
  updateUserPreferences,
} from "./user.actions";

export const loadTones = async (): Promise<void> => {
  const tones = await getToneRepo().listTones();
  produceAppState((draft) => {
    registerTones(draft, tones);
  });
};

export const upsertTone = async (
  tone: Tone,
  { activate = true }: { activate?: boolean } = {},
): Promise<Tone> =>
  withLocalDataWrite(async (lease) => {
    try {
      const saved = await getToneRepo().upsertTone(tone, lease);

      produceAppState((draft) => {
        registerTones(draft, [saved]);
        if (activate) draft.tones.selectedToneId = saved.id;
        draft.tones.isCreating = false;
      }, lease);

      if (activate) await activateAndSelectTone(saved.id, lease);

      showSnackbar("Tone saved successfully", { mode: "success" });
      return saved;
    } catch (error) {
      console.error("Failed to save tone", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to save tone.",
      );
      throw error;
    }
  });

export const deleteTone = async (id: string): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    try {
      const shouldClearActiveTone =
        getAppState().userPrefs?.activeToneId === id;
      await getToneRepo().deleteTone(id, lease);

      produceAppState((draft) => {
        delete draft.toneById[id];
        // Remove the record and its editor in one state transition, before any
        // slower preference sync. Never close an editor for a different tone.
        if (
          draft.toneEditor.mode === "edit" &&
          draft.toneEditor.toneId === id
        ) {
          draft.toneEditor.open = false;
        }

        if (draft.tones.selectedToneId === id) {
          draft.tones.selectedToneId = null;
        }
        if (draft.userPrefs?.activeToneId === id) {
          draft.userPrefs.activeToneId = null;
        }
      }, lease);

      if (shouldClearActiveTone) {
        await updateUserPreferences(
          (preferences) => {
            preferences.activeToneId = null;
          },
          "Failed to clear the deleted tone preference. Please try again.",
          { existingLease: lease },
        );
      }

      showSnackbar("Tone deleted successfully", { mode: "success" });
    } catch (error) {
      console.error("Failed to delete tone", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to delete tone.",
      );
      throw error;
    }
  });

export const setActiveTone = async (toneId: string | null): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    try {
      if (!getAppState().userPrefs) {
        throw new Error("User preferences not found");
      }

      await updateUserPreferences(
        (preferences) => {
          preferences.activeToneId = toneId;
        },
        "Failed to save active tone. Please try again.",
        { existingLease: lease },
      );

      showSnackbar(toneId ? "Default tone set" : "Default tone cleared", {
        mode: "success",
      });
    } catch (error) {
      console.error("Failed to set active tone", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to set active tone.",
      );
      throw error;
    }
  });

export const getActiveTone = (): Tone | null => {
  const state = getAppState();
  const prefs = state.userPrefs;
  const activeToneId = prefs?.activeToneId;

  if (!activeToneId) {
    return null;
  }

  return state.toneById[activeToneId] ?? null;
};

export const openToneEditorDialog = (options: {
  mode: ToneEditorMode;
  toneId?: string | null;
  targetId?: string | null;
}): void => {
  produceAppState((draft) => {
    draft.toneEditor.open = true;
    draft.toneEditor.mode = options.mode;
    draft.toneEditor.toneId = options.toneId ?? null;
    draft.toneEditor.targetId = options.targetId ?? null;
  });
};

/**
 * Apply the writing-style selection in memory immediately. Persist is
 * fire-and-forget from the caller's point of view: a stop that races the
 * DB write must still snapshot the newly selected tone.
 *
 * Returns false when there is no user. Callers must skip persist in that
 * case so in-memory and persisted state stay aligned (`setSelectedToneId`
 * would also no-op, but only after a snackbar).
 *
 * Does not touch `updatedAt` — that stays owned by `setSelectedToneId`.
 */
export const applyWritingStyleSelectionNow = (
  toneId: string,
  lease?: LocalDataWriteLease,
): boolean => {
  const existing = getMyUser(getAppState());
  if (!existing) {
    return false;
  }
  if (existing.selectedToneId === toneId) {
    return true;
  }
  produceAppState((draft) => {
    const user = getMyUser(draft);
    if (user) {
      user.selectedToneId = toneId;
    }
  }, lease);
  return true;
};

let styleSwitchNonce = 0;

/**
 * Persist-assisted style switch: snapshot the current selection, write the
 * new one in memory, then persist. If persistence fails, keep the in-memory
 * selection. A monotonic nonce ensures out-of-order responses do not clobber
 * newer selections.
 */
const applyWritingStyleSelectionWithPersist = async (
  toneId: string,
): Promise<void> => {
  const write = beginLocalDataWrite();
  if (!write) return;

  const nonce = ++styleSwitchNonce;
  if (!applyWritingStyleSelectionNow(toneId, write.lease)) {
    write();
    return;
  }
  try {
    await setSelectedToneId(toneId, write.lease);
  } catch (error) {
    if (nonce === styleSwitchNonce) {
      getLogger().error(
        `Style selection persist failed; in-memory selection remains: ${error}`,
      );
    }
  } finally {
    write();
  }
};

/**
 * Single state transition for every writing-style switch channel (pill
 * chevrons, Left/Right while holding dictate, cycle hotkeys, and
 * switch-to-style hotkeys). The in-memory write is synchronous; persistence
 * is returned as a Promise the caller may ignore.
 */
export const applyWritingStyleSelection = async (
  toneId: string,
): Promise<void> => {
  await applyWritingStyleSelectionWithPersist(toneId);
};

const peekCycledToneId = (direction: 1 | -1): string | null => {
  const state = getAppState();
  const activeIds = getActiveManualToneIds(state);
  if (activeIds.length <= 1) {
    return null;
  }
  const currentId = getManuallySelectedToneId(state);
  const currentIndex = activeIds.indexOf(currentId);
  return activeIds[
    (currentIndex + direction + activeIds.length) % activeIds.length
  ];
};

const notifyOnlyActiveStyle = async (): Promise<void> => {
  const state = getAppState();
  const currentId = getManuallySelectedToneId(state);
  const toneName = getToneById(state, currentId)?.name ?? currentId;
  await showToast({
    message: getIntl().formatMessage(
      {
        defaultMessage: '"{toneName}" is your only active style',
      },
      { toneName },
    ),
    toastType: "info",
  });
};

const cycleWritingStyle = async (direction: 1 | -1): Promise<void> => {
  const nextId = peekCycledToneId(direction);
  if (nextId === null) {
    await notifyOnlyActiveStyle();
    return;
  }
  await applyWritingStyleSelection(nextId);
};

export const switchWritingStyleForward = () => cycleWritingStyle(1);
export const switchWritingStyleBackward = () => cycleWritingStyle(-1);

/** Select a style from a dynamic global style shortcut. */
export const selectToneByHotkey = async (toneId: string): Promise<void> => {
  await applyWritingStyleSelection(toneId);
};

/**
 * Shared entry point for every in-dictation style-switch channel.
 *
 * The in-memory `selectedToneId` is written before this function returns
 * its persist Promise, so `void applyInDictationStyleSwitch(...)` is
 * visible to a stop that runs in the same turn.
 */
export const applyInDictationStyleSwitch = (
  request: WritingStyleSwitchRequest,
): Promise<void> => {
  const transition = toWritingStyleTransition(request);
  if (transition.kind === "select") {
    return applyWritingStyleSelectionWithPersist(transition.toneId);
  }
  const nextId = peekCycledToneId(transition.direction);
  if (nextId === null) {
    return notifyOnlyActiveStyle();
  }
  return applyWritingStyleSelectionWithPersist(nextId);
};

export const closeToneEditorDialog = (): void => {
  produceAppState((draft) => {
    draft.toneEditor.open = false;
  });
};
