import { invoke } from "@tauri-apps/api/core";
import { Tone } from "@maus-inc/types";
import { getIntl } from "../i18n/intl";
import { getToneRepo, getUserPreferencesRepo } from "../repos";
import { ToneEditorMode } from "../state/tone-editor.state";
import { getAppState, produceAppState } from "../store";
import { registerTones } from "../utils/app.utils";
import { getEffectiveStylingMode } from "../utils/feature.utils";
import { getLogger } from "../utils/log.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
} from "../utils/tone.utils";
import { showErrorSnackbar, showSnackbar } from "./app.actions";
import { showToast } from "./toast.actions";
import { activateAndSelectTone, setSelectedToneId } from "./user.actions";

/** Tauri events the pill bridge emits when a chevron is clicked. */
export const PILL_STYLE_SWITCH_FORWARD_EVENT = "tone-switch-forward";
export const PILL_STYLE_SWITCH_BACKWARD_EVENT = "tone-switch-backward";

export const loadTones = async (): Promise<void> => {
  const tones = await getToneRepo().listTones();
  produceAppState((draft) => {
    registerTones(draft, tones);
  });
};

export const upsertTone = async (tone: Tone): Promise<Tone> => {
  try {
    const saved = await getToneRepo().upsertTone(tone);

    produceAppState((draft) => {
      registerTones(draft, [saved]);
      draft.tones.selectedToneId = saved.id;
      draft.tones.isCreating = false;
    });

    await activateAndSelectTone(saved.id);

    showSnackbar("Tone saved successfully", { mode: "success" });
    return saved;
  } catch (error) {
    console.error("Failed to save tone", error);
    showErrorSnackbar(
      error instanceof Error ? error.message : "Failed to save tone.",
    );
    throw error;
  }
};

export const deleteTone = async (id: string): Promise<void> => {
  try {
    await getToneRepo().deleteTone(id);

    produceAppState((draft) => {
      delete draft.toneById[id];

      // Clear selection if deleting the currently selected tone
      if (draft.tones.selectedToneId === id) {
        draft.tones.selectedToneId = null;
      }

      // Clear active tone if deleting the currently active tone
      const prefs = draft.userPrefs;
      if (prefs?.activeToneId === id) {
        prefs.activeToneId = null;
      }
    });

    // Sync preferences if we cleared the active tone
    const prefs = getAppState().userPrefs;
    if (prefs && prefs.activeToneId === null) {
      await getUserPreferencesRepo().setUserPreferences(prefs);
    }

    showSnackbar("Tone deleted successfully", { mode: "success" });
  } catch (error) {
    console.error("Failed to delete tone", error);
    showErrorSnackbar(
      error instanceof Error ? error.message : "Failed to delete tone.",
    );
    throw error;
  }
};

export const setActiveTone = async (toneId: string | null): Promise<void> => {
  try {
    const currentPrefs = getAppState().userPrefs;
    if (!currentPrefs) {
      throw new Error("User preferences not found");
    }

    const updatedPrefs = {
      ...currentPrefs,
      activeToneId: toneId,
    };

    await getUserPreferencesRepo().setUserPreferences(updatedPrefs);
    produceAppState((draft) => {
      draft.userPrefs = updatedPrefs;
    });

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
};

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
 * Serializes style-switch mutations so rapid chevron / hotkey clicks each
 * see the previous write. Overlapping `setSelectedToneId` calls would
 * otherwise all read the same current id and collapse to a single step.
 */
let styleSwitchQueue: Promise<void> = Promise.resolve();

const enqueueStyleSwitch = (task: () => Promise<void>): Promise<void> => {
  const run = styleSwitchQueue.then(task, task);
  styleSwitchQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/** Snapshot the pill should display: applied active style, never a preview. */
export const getPillStyleInfo = (
  state = getAppState(),
): { count: number; name: string } => {
  if (getEffectiveStylingMode(state) !== "manual") {
    return { count: 0, name: "-" };
  }
  const count = getActiveManualToneIds(state).length;
  const toneId = getManuallySelectedToneId(state);
  const name = getToneById(state, toneId)?.name ?? "-";
  return { count, name };
};

/** Push the applied style to the native pill so the tooltip cannot drift. */
export const syncPillStyleInfo = async (): Promise<void> => {
  const { count, name } = getPillStyleInfo();
  try {
    await invoke("notify_pill_style_info", { count, name });
  } catch (error) {
    getLogger().verbose(`Failed to sync pill style info: ${error}`);
  }
};

/**
 * Shared writing-style cycle used by every switch channel (in-app selectors,
 * style hotkeys, in-dictation arrows, and the pill chevrons).
 */
export const cycleWritingStyle = (direction: 1 | -1): Promise<void> =>
  enqueueStyleSwitch(async () => {
    const state = getAppState();
    const activeIds = getActiveManualToneIds(state);
    const currentId = getManuallySelectedToneId(state);
    const intl = getIntl();

    if (activeIds.length <= 1) {
      const toneName = getToneById(state, currentId)?.name ?? currentId;
      await showToast({
        message: intl.formatMessage(
          {
            defaultMessage: '"{toneName}" is your only active style',
          },
          { toneName },
        ),
        toastType: "info",
      });
      return;
    }

    const currentIndex = activeIds.indexOf(currentId);
    const nextIndex =
      (currentIndex + direction + activeIds.length) % activeIds.length;
    const nextId = activeIds[nextIndex];
    await setSelectedToneId(nextId);
  });

export const switchWritingStyleForward = (): Promise<void> =>
  cycleWritingStyle(1);
export const switchWritingStyleBackward = (): Promise<void> =>
  cycleWritingStyle(-1);

/**
 * Pill chevron handler. Always runs the shared cycle (idle, recording,
 * paused) and then pushes StyleInfo so the tooltip name matches the
 * applied style even if the React sync effect has not flushed yet.
 */
export const handlePillStyleSwitch = async (
  direction: string,
): Promise<void> => {
  const normalized = direction.trim().toLowerCase();
  getLogger().info(`Pill style switch received (${normalized})`);
  if (normalized === "forward") {
    await switchWritingStyleForward();
  } else if (normalized === "backward") {
    await switchWritingStyleBackward();
  } else {
    getLogger().warning(
      `Ignoring unknown pill style-switch direction: ${direction}`,
    );
    return;
  }
  await syncPillStyleInfo();
};

/** Select a style from a dynamic global style shortcut. */
export const selectToneByHotkey = async (toneId: string): Promise<void> => {
  await setSelectedToneId(toneId);
  await syncPillStyleInfo();
};

export const closeToneEditorDialog = (): void => {
  produceAppState((draft) => {
    draft.toneEditor.open = false;
  });
};
