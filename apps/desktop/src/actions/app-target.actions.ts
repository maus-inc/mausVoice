import { invoke } from "@tauri-apps/api/core";
import { AppTarget, Nullable } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getAppTargetRepo, getStorageRepo } from "../repos";
import { AppTargetUpsertParams } from "../repos/app-target.repo";
import { getAppState, produceAppState } from "../store";
import { registerAppTargets } from "../utils/app.utils";
import { normalizeAppTargetId } from "../utils/apptarget.utils";
import { createMutationQueue } from "../utils/mutation-queue";
import { getEffectiveStylingMode } from "../utils/feature.utils";
import { getLogger } from "../utils/log.utils";
import { buildAppIconPath, decodeBase64Icon } from "../utils/storage.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
} from "../utils/tone.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import {
  type LocalDataWriteLease,
  beginLocalDataWrite,
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { showErrorSnackbar } from "./app.actions";
import { setSelectedToneId } from "./user.actions";

// Reads and whole-row mutations share a queue so a late refresh cannot restore
// a snapshot taken before a save. This is scoped to this renderer only.
const appTargetWrites = createMutationQueue();
const targetsNeedingReconciliation = new Set<string>();

export const loadAppTargets = (): Promise<void> => {
  const generation = getLocalDataClearGeneration();
  return appTargetWrites.enqueue(async () => {
    if (
      isLocalDataClearRequested() ||
      generation !== getLocalDataClearGeneration()
    )
      return;
    const targets = await getAppTargetRepo().listAppTargets();
    if (
      isLocalDataClearRequested() ||
      generation !== getLocalDataClearGeneration()
    )
      return;
    produceAppState((draft) => {
      registerAppTargets(draft, targets);
      for (const id of targetsNeedingReconciliation) {
        if (!targets.some((target) => target.id === id))
          delete draft.appTargetById[id];
      }
    });
    targetsNeedingReconciliation.clear();
  });
};

// Hold the local-data lease while waiting in the queue as well as while writing.
// Read the target inside the queue so changes to different fields compose.
const enqueueAppTargetWrite = <T>(
  task: (lease: LocalDataWriteLease) => Promise<T>,
  lease?: LocalDataWriteLease,
): Promise<T> =>
  withLocalDataWrite(
    (writeLease) => appTargetWrites.enqueue(() => task(writeLease)),
    lease,
  );

const reconcileAppTarget = async (id: string, lease: LocalDataWriteLease) => {
  if (!targetsNeedingReconciliation.has(id)) return;
  const targets = await getAppTargetRepo().listAppTargets();
  const target = targets.find((item) => item.id === id);
  produceAppState((draft) => {
    if (target) registerAppTargets(draft, [target]);
    else delete draft.appTargetById[id];
  }, lease);
  targetsNeedingReconciliation.delete(id);
};

const persistAppTarget = async (
  params: AppTargetUpsertParams,
  lease: LocalDataWriteLease,
): Promise<AppTarget> => {
  try {
    const target = await getAppTargetRepo().upsertAppTarget(params, lease);
    produceAppState((draft) => {
      registerAppTargets(draft, [target]);
    }, lease);
    return target;
  } catch (error) {
    // A failed IPC response does not prove the whole-row upsert did not commit.
    // The next mutation must re-read or fail rather than overwrite unknown data.
    targetsNeedingReconciliation.add(params.id);
    try {
      await reconcileAppTarget(params.id, lease);
    } catch (recoveryError) {
      getLogger().error(
        `Failed to reload app target after save: ${recoveryError}`,
      );
    }
    throw error;
  }
};

type AppTargetChanges = Partial<
  Pick<
    AppTargetUpsertParams,
    "toneId" | "pasteKeybind" | "insertionMethod" | "typingSpeedMs"
  >
>;

const updateAppTarget = (
  id: string,
  changes: AppTargetChanges,
): Promise<boolean> =>
  enqueueAppTargetWrite(async (lease) => {
    await reconcileAppTarget(id, lease);
    const existing = getAppState().appTargetById[id];
    if (!existing) {
      showErrorSnackbar("App target is not registered.");
      return false;
    }
    await persistAppTarget(
      {
        id,
        name: existing.name,
        toneId: existing.toneId ?? null,
        iconPath: existing.iconPath ?? null,
        pasteKeybind: existing.pasteKeybind ?? null,
        insertionMethod: existing.insertionMethod ?? null,
        typingSpeedMs: existing.typingSpeedMs ?? null,
        ...changes,
      },
      lease,
    );
    return true;
  });

export const setAppTargetTone = async (
  id: string,
  toneId: string | null,
): Promise<boolean> => {
  try {
    return await updateAppTarget(id, { toneId });
  } catch (error) {
    console.error("Failed to update app target tone", error);
    showErrorSnackbar(
      error instanceof Error
        ? error.message
        : "Failed to update app target tone.",
    );
    return false;
  }
};

export const setAppTargetPasteKeybind = async (
  id: string,
  pasteKeybind: string | null,
): Promise<void> => {
  try {
    await updateAppTarget(id, { pasteKeybind });
  } catch (error) {
    console.error("Failed to update app target paste keybind", error);
    showErrorSnackbar(
      error instanceof Error
        ? error.message
        : "Failed to update app target paste keybind.",
    );
  }
};

export const setAppTargetInsertionMethod = async (
  id: string,
  insertionMethod: string | null,
): Promise<void> => {
  try {
    await updateAppTarget(id, { insertionMethod });
  } catch (error) {
    console.error("Failed to update app target insertion method", error);
    showErrorSnackbar(
      error instanceof Error
        ? error.message
        : "Failed to update app target insertion method.",
    );
  }
};

export const setAppTargetTypingSpeed = async (
  id: string,
  typingSpeedMs: number | null,
): Promise<void> => {
  try {
    await updateAppTarget(id, { typingSpeedMs });
  } catch (error) {
    console.error("Failed to update app target typing speed", error);
    showErrorSnackbar(
      error instanceof Error
        ? error.message
        : "Failed to update app target typing speed.",
    );
  }
};

type CurrentAppInfoResponse = {
  appName: string;
  iconBase64: string;
};

export const tryRegisterCurrentAppTarget = async (): Promise<
  Nullable<AppTarget>
> => {
  const appInfo = await getLogger().stopwatch("get_current_app_info", () =>
    invoke<CurrentAppInfoResponse>("get_current_app_info"),
  );

  const appName = appInfo.appName?.trim() ?? "";
  const appTargetId = normalizeAppTargetId(appName);
  const existingApp = getRec(getAppState().appTargetById, appTargetId);

  // Surface the current foreground app on the tray menu so the user knows what
  // "Register current app" will act on before they click it.
  invoke<void>("set_register_app_label", { appName: appName || null }).catch(
    () => {
      // Best-effort: the tray label is cosmetic; ignore failures.
    },
  );

  const shouldRegisterAppTarget = !existingApp || !existingApp.iconPath;
  if (shouldRegisterAppTarget) {
    const releaseWrite = beginLocalDataWrite();
    if (releaseWrite) {
      try {
        let iconPath: string | undefined;
        if (appInfo.iconBase64) {
          const targetPath = buildAppIconPath(getAppState(), appTargetId);
          try {
            await getLogger().stopwatch("upload_app_icon", async () => {
              await getStorageRepo().uploadData(
                {
                  path: targetPath,
                  data: decodeBase64Icon(appInfo.iconBase64),
                },
                releaseWrite.lease,
              );
            });
            iconPath = targetPath;
          } catch (uploadError) {
            console.error("Failed to upload app icon", uploadError);
          }
        }

        try {
          await getLogger().stopwatch("upsert_app_target", () =>
            enqueueAppTargetWrite(async (lease) => {
              await reconcileAppTarget(appTargetId, lease);
              // An edit or another registration may have completed during the
              // icon upload. Preserve the latest fields, including explicit nulls.
              const latest = getRec(getAppState().appTargetById, appTargetId);
              const defaultPasteKeybind =
                getMyUserPreferences(getAppState())?.pasteKeybind ?? null;
              await persistAppTarget(
                {
                  id: appTargetId,
                  name: appName,
                  toneId: latest?.toneId ?? null,
                  iconPath: iconPath ?? latest?.iconPath ?? null,
                  pasteKeybind: latest
                    ? (latest.pasteKeybind ?? null)
                    : defaultPasteKeybind,
                  insertionMethod: latest?.insertionMethod ?? null,
                  typingSpeedMs: latest?.typingSpeedMs ?? null,
                },
                lease,
              );
            }, releaseWrite.lease),
          );
        } catch (error) {
          console.error("Failed to upsert app target", error);
        }
      } finally {
        releaseWrite();
      }
    }
  }

  return getRec(getAppState().appTargetById, appTargetId) ?? null;
};

export const loadManualStyleForCurrentApp = async (): Promise<void> => {
  if (getEffectiveStylingMode(getAppState()) !== "manual") return;

  try {
    const appInfo = await invoke<{ appName: string }>("get_current_app_info");
    const appTargetId = normalizeAppTargetId(appInfo.appName?.trim() ?? "");
    const appTarget = getAppState().appTargetById[appTargetId];
    if (appTarget?.toneId) {
      const activeIds = getActiveManualToneIds(getAppState());
      if (activeIds.includes(appTarget.toneId)) {
        await setSelectedToneId(appTarget.toneId);
      }
    }
  } catch (error) {
    getLogger().verbose(`Failed to load app style: ${error}`);
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
): Promise<void> => {
  if (getEffectiveStylingMode(getAppState()) !== "manual") {
    return;
  }

  const manualToneId = getManuallySelectedToneId(getAppState());
  if (manualToneId === (appTarget.toneId ?? null)) {
    return;
  }
  await setAppTargetTone(appTarget.id, manualToneId).catch((error) => {
    getLogger().verbose(`Failed to save app style: ${error}`);
  });
};
