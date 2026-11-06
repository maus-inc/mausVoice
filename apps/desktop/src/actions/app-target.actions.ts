import { invoke } from "@tauri-apps/api/core";
import { AppTarget, Nullable } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getAppTargetRepo, getStorageRepo } from "../repos";
import { AppTargetUpsertParams } from "../repos/app-target.repo";
import { getAppState, produceAppState } from "../store";
import { registerAppTargets } from "../utils/app.utils";
import { normalizeAppTargetId } from "../utils/apptarget.utils";
import { getEffectiveStylingMode } from "../utils/feature.utils";
import { getLogger } from "../utils/log.utils";
import { buildAppIconPath, decodeBase64Icon } from "../utils/storage.utils";
import { withTimeout } from "../utils/timeout.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
} from "../utils/tone.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { setSelectedToneId } from "./user.actions";

export const loadAppTargets = async (): Promise<void> => {
  const targets = await getAppTargetRepo().listAppTargets();

  produceAppState((draft) => {
    registerAppTargets(draft, targets);
  });
};

const upsertAppTarget = async (
  params: AppTargetUpsertParams,
): Promise<AppTarget> => {
  const target = await getAppTargetRepo().upsertAppTarget(params);

  produceAppState((draft) => {
    registerAppTargets(draft, [target]);
  });

  return target;
};

// App-target upserts replace the entire row. Serialize writes per target and
// construct each row only when its turn starts, after preceding writes have
// updated the store. Different applications remain independent.
const targetWrites = new Map<string, Promise<void>>();
const queueTargetWrite = <T>(
  id: string,
  write: () => Promise<T>,
): Promise<T> => {
  const previous = targetWrites.get(id);
  const result = previous ? previous.then(write) : write();
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  targetWrites.set(id, settled);
  void settled.then(() => {
    if (targetWrites.get(id) === settled) targetWrites.delete(id);
  });
  return result;
};

type AppTargetPatch = Partial<
  Pick<
    AppTargetUpsertParams,
    "toneId" | "pasteKeybind" | "insertionMethod" | "typingSpeedMs"
  >
>;

/** Merge a partial change over the stored row, keeping every other column. */
const mergeTargetPatch = (
  id: string,
  existing: AppTarget,
  patch: AppTargetPatch,
): AppTargetUpsertParams => ({
  id,
  name: existing.name,
  toneId: existing.toneId ?? null,
  iconPath: existing.iconPath ?? null,
  pasteKeybind: existing.pasteKeybind ?? null,
  insertionMethod: existing.insertionMethod ?? null,
  typingSpeedMs: existing.typingSpeedMs ?? null,
  ...patch,
});

/** Report a failed field write once, with the provider's message when there is one. */
const reportTargetUpdateFailure = (
  error: unknown,
  fieldDescription: string,
): void => {
  console.error(`Failed to update app target ${fieldDescription}`, error);
  showErrorSnackbar(
    error instanceof Error
      ? error.message
      : `Failed to update app target ${fieldDescription}.`,
  );
};

const updateAppTarget = async (
  id: string,
  patch: AppTargetPatch,
  fieldDescription: string,
  options?: { isCurrent?: () => boolean; skipUnchangedTone?: boolean },
): Promise<boolean> =>
  queueTargetWrite(id, async () => {
    if (options?.isCurrent && !options.isCurrent()) return false;
    const existing = getAppState().appTargetById[id];
    if (!existing) {
      showErrorSnackbar("App target is not registered.");
      return false;
    }
    // A queued write for the tone that is already stored has nothing to send.
    if (
      options?.skipUnchangedTone &&
      (existing.toneId ?? null) === (patch.toneId ?? null)
    )
      return true;

    try {
      await upsertAppTarget(mergeTargetPatch(id, existing, patch));
      return true;
    } catch (error) {
      reportTargetUpdateFailure(error, fieldDescription);
      return false;
    }
  });

export const setAppTargetTone = (
  id: string,
  toneId: string | null,
): Promise<boolean> => updateAppTarget(id, { toneId }, "tone");

export const setAppTargetPasteKeybind = async (
  id: string,
  pasteKeybind: string | null,
): Promise<void> => {
  await updateAppTarget(id, { pasteKeybind }, "paste keybind");
};

export const setAppTargetInsertionMethod = async (
  id: string,
  insertionMethod: string | null,
): Promise<void> => {
  await updateAppTarget(id, { insertionMethod }, "insertion method");
};

export const setAppTargetTypingSpeed = async (
  id: string,
  typingSpeedMs: number | null,
): Promise<void> => {
  await updateAppTarget(id, { typingSpeedMs }, "typing speed");
};

type CurrentAppInfoResponse = {
  appName: string;
  iconBase64: string;
};

/** Compose a registration without dropping per-app settings when adding its icon. */
const registrationParams = (
  id: string,
  name: string,
  uploadedIcon: string | undefined,
  existing: AppTarget | undefined,
  defaultPasteKeybind: string | null,
): AppTargetUpsertParams => {
  const saved: Partial<AppTarget> = existing ?? {};
  return {
    id,
    name,
    toneId: saved.toneId ?? null,
    iconPath: uploadedIcon ?? saved.iconPath ?? null,
    pasteKeybind: saved.pasteKeybind ?? defaultPasteKeybind,
    insertionMethod: saved.insertionMethod ?? null,
    typingSpeedMs: saved.typingSpeedMs ?? null,
  };
};

/** The tray label is cosmetic, so a failed update is ignored. */
const surfaceCurrentAppLabel = (appName: string): void => {
  invoke<void>("set_register_app_label", { appName: appName || null }).catch(
    () => {
      // Best-effort: the user still sees the dialog if this fails.
    },
  );
};

/** Upload the app icon, or `undefined` when there is none or it cannot ship. */
const uploadAppIcon = async (
  appTargetId: string,
  iconBase64: string | undefined,
): Promise<string | undefined> => {
  if (!iconBase64) return undefined;
  const targetPath = buildAppIconPath(getAppState(), appTargetId);
  try {
    await getLogger().stopwatch("upload_app_icon", async () => {
      await getStorageRepo().uploadData({
        path: targetPath,
        data: decodeBase64Icon(iconBase64),
      });
    });
    return targetPath;
  } catch (uploadError) {
    console.error("Failed to upload app icon", uploadError);
    return undefined;
  }
};

/**
 * Write the registration. The queued write re-reads the row so it merges with
 * whatever landed while the icon was uploading.
 */
const upsertRegisteredTarget = async (
  appTargetId: string,
  appName: string,
  iconPath: string | undefined,
  isCurrent: () => boolean,
): Promise<void> => {
  try {
    await getLogger().stopwatch("upsert_app_target", async () => {
      await queueTargetWrite(appTargetId, async () => {
        if (!isCurrent()) return;
        const latest = getRec(getAppState().appTargetById, appTargetId);
        const defaultPasteKeybind =
          getMyUserPreferences(getAppState())?.pasteKeybind ?? null;
        await upsertAppTarget(
          registrationParams(
            appTargetId,
            appName,
            iconPath,
            latest,
            defaultPasteKeybind,
          ),
        );
      });
    });
  } catch (error) {
    console.error("Failed to upsert app target", error);
  }
};

export const tryRegisterCurrentAppTarget = async (
  isCurrent: () => boolean = () => true,
): Promise<Nullable<AppTarget>> => {
  const appInfo = await getLogger().stopwatch("get_current_app_info", () =>
    invoke<CurrentAppInfoResponse>("get_current_app_info"),
  );
  if (!isCurrent()) return null;

  const appName = appInfo.appName?.trim() ?? "";
  const appTargetId = normalizeAppTargetId(appName);
  const existingApp = getRec(getAppState().appTargetById, appTargetId);

  // Surface the current foreground app on the tray menu so the user knows what
  // "Register current app" will act on before they click it.
  surfaceCurrentAppLabel(appName);

  const shouldRegisterAppTarget = !existingApp || !existingApp.iconPath;
  if (shouldRegisterAppTarget) {
    const iconPath = await uploadAppIcon(appTargetId, appInfo.iconBase64);
    if (!isCurrent()) return null;
    await upsertRegisteredTarget(appTargetId, appName, iconPath, isCurrent);
  }

  return isCurrent()
    ? (getRec(getAppState().appTargetById, appTargetId) ?? null)
    : null;
};

const loadManualStyle = async (isCurrent: () => boolean): Promise<void> => {
  const initial = getAppState();
  if (!isCurrent() || getEffectiveStylingMode(initial) !== "manual") return;
  const initialSelection = getManuallySelectedToneId(initial);

  try {
    const appInfo = await invoke<{ appName: string }>("get_current_app_info");
    if (!isCurrent()) return;
    const appTargetId = normalizeAppTargetId(appInfo.appName?.trim() ?? "");
    const toneId = getAppState().appTargetById[appTargetId]?.toneId;
    if (!toneId) return;
    // The user mutation may wait behind unrelated writes. Recheck ownership,
    // the user's selection and the app setting at the head of that queue.
    const shouldApply = () => {
      const state = getAppState();
      return (
        isCurrent() &&
        getEffectiveStylingMode(state) === "manual" &&
        getManuallySelectedToneId(state) === initialSelection &&
        state.appTargetById[appTargetId]?.toneId === toneId &&
        getActiveManualToneIds(state).includes(toneId)
      );
    };
    if (shouldApply()) await setSelectedToneId(toneId, shouldApply);
  } catch (error) {
    getLogger().verbose(`Failed to load app style: ${error}`);
  }
};

/** Do not let an unresponsive app lookup hold recording activation open. */
export const loadManualStyleForCurrentApp = async (
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  let expired = false;
  try {
    await withTimeout(
      loadManualStyle(() => !expired && isCurrent()),
      2_000,
      "Current app style lookup",
      () => {
        expired = true;
      },
    );
  } catch {
    getLogger().verbose("Current app style lookup timed out");
  }
};

/**
 * Persist the live manual selection as the per-app tone at finalize.
 *
 * Source-of-truth contract:
 * - `getManuallySelectedToneId` reads the LIVE `user.selectedToneId`, which
 *   `applyWritingStyleSelection` updates on every switch channel. A switch
 *   made mid-dictation therefore reaches the live selection before stop
 *   fires, and `saveManualStyleForApp` writes that new tone to the app
 *   target — the start-time tone is the post-processing input for the
 *   ACTIVE utterance, not the saved default.
 * - Never read from any start-time snapshot here. Doing so would silently
 *   revert the user's mid-recording switch.
 *
 * Returns the persistence promise (already error-logged, never rejects)
 * so callers can await it; fire-and-forget callers are unaffected.
 */
export const saveManualStyleForApp = async (
  appTarget: AppTarget,
  options?: { toneId: string; isCurrent: () => boolean },
): Promise<void> => {
  if (getEffectiveStylingMode(getAppState()) !== "manual") return;
  const manualToneId =
    options?.toneId ?? getManuallySelectedToneId(getAppState());
  await updateAppTarget(appTarget.id, { toneId: manualToneId }, "tone", {
    // A queued old stop must not overwrite a later recording or a style the
    // user selected after stopping. Already-dispatched database writes cannot
    // be canceled here, but remain ordered with later per-target writes.
    isCurrent: options
      ? () =>
          options.isCurrent() &&
          getEffectiveStylingMode(getAppState()) === "manual" &&
          getManuallySelectedToneId(getAppState()) === manualToneId
      : undefined,
    skipUnchangedTone: true,
  }).catch(() => {
    getLogger().verbose("Failed to save app style");
  });
};
