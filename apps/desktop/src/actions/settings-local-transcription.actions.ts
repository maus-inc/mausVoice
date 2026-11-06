import type { AppState } from "../state/app.state";
import { CPU_DEVICE_VALUE } from "../types/ai.types";
import {
  createEmptyLocalTranscriptionModelStatusMap,
  isLocalTranscriptionModelDownloadInProgress,
  type LocalTranscriptionModelStatusMap,
} from "../state/settings.state";
import { getAppState, produceAppState } from "../store";
import {
  getLocalTranscriptionSidecarManager,
  type LocalSidecarDevice,
  type LocalTranscriptionSidecarManager,
} from "../sidecars";
import {
  isGpuPreferredTranscriptionDevice,
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModel,
  normalizeTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { getEffectiveTranscriptionMode } from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { setPreferredTranscriptionDevice } from "./user.actions";

const getPreferGpu = (state: AppState): boolean =>
  isGpuPreferredTranscriptionDevice(state.settings.aiTranscription.device);

const resolvePreferredDevice = (
  currentDevice: string,
  devices: LocalSidecarDevice[],
): string => {
  const normalizedCurrent = normalizeTranscriptionDevice(currentDevice);
  if (devices.some((device) => device.id === normalizedCurrent)) {
    return normalizedCurrent;
  }

  const firstCpuDevice = devices.find((device) => device.mode === "cpu")?.id;
  const firstGpuDevice = devices.find((device) => device.mode === "gpu")?.id;
  if (normalizedCurrent.startsWith("gpu")) {
    return firstGpuDevice ?? firstCpuDevice ?? CPU_DEVICE_VALUE;
  }

  return firstCpuDevice ?? firstGpuDevice ?? CPU_DEVICE_VALUE;
};

export const refreshLocalTranscriptionDevices = async ({
  showErrors = true,
}: {
  showErrors?: boolean;
} = {}): Promise<LocalSidecarDevice[] | null> => {
  const state = getAppState();
  if (getEffectiveTranscriptionMode(state) !== "local") {
    return null;
  }

  produceAppState((draft) => {
    draft.settings.aiTranscription.availableDevicesLoading = true;
  });

  try {
    const sidecarManager: LocalTranscriptionSidecarManager =
      getLocalTranscriptionSidecarManager();
    const devices = await sidecarManager.listAvailableDevices();
    const resolvedDevice = resolvePreferredDevice(
      state.settings.aiTranscription.device,
      devices,
    );

    produceAppState((draft) => {
      draft.settings.aiTranscription.availableDevices = devices;
    });

    if (resolvedDevice !== state.settings.aiTranscription.device) {
      await setPreferredTranscriptionDevice(resolvedDevice);
    }

    return devices;
  } catch (error) {
    produceAppState((draft) => {
      draft.settings.aiTranscription.availableDevices = [];
    });

    if (showErrors) {
      showErrorSnackbar(`Unable to load local devices: ${error}`);
    }

    return null;
  } finally {
    produceAppState((draft) => {
      draft.settings.aiTranscription.availableDevicesLoading = false;
    });
  }
};

export const refreshLocalTranscriptionModelStatuses = async ({
  showErrors = true,
}: {
  showErrors?: boolean;
} = {}): Promise<LocalTranscriptionModelStatusMap | null> => {
  const state = getAppState();
  if (getEffectiveTranscriptionMode(state) !== "local") {
    return null;
  }

  const preferGpu = getPreferGpu(state);
  const sidecarManager = getLocalTranscriptionSidecarManager();

  produceAppState((draft) => {
    draft.settings.aiTranscription.localModelManagement.modelStatusesLoading = true;
  });

  try {
    const statuses = await sidecarManager.listModelStatuses({
      preferGpu,
      validate: true,
      models: LOCAL_WHISPER_MODELS,
    });

    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelStatuses =
        statuses;
      draft.settings.aiTranscription.localModelManagement.modelStatusesLoaded = true;
    });

    return statuses;
  } catch (error) {
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelStatuses =
        createEmptyLocalTranscriptionModelStatusMap();
      draft.settings.aiTranscription.localModelManagement.modelStatusesLoaded = false;
    });

    if (showErrors) {
      showErrorSnackbar(`Unable to load local model status: ${error}`);
    }
    return null;
  } finally {
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelStatusesLoading = false;
    });
  }
};

// A worker owns its model until it completes, is paused, or is canceled.
// The token lets a resumed worker supersede the old worker's late polls.
const downloadOwners = new Map<LocalWhisperModel, symbol>();
const cancellingDownloads = new Set<LocalWhisperModel>();
const downloadStarts = new Map<LocalWhisperModel, Promise<boolean>>();
const downloadRevisions = new Map<LocalWhisperModel, number>();
const bumpDownloadRevision = (model: LocalWhisperModel) => {
  const revision = (downloadRevisions.get(model) ?? 0) + 1;
  downloadRevisions.set(model, revision);
  return revision;
};

export const downloadLocalTranscriptionModel = async (
  model: LocalWhisperModel,
): Promise<void> => {
  const state = getAppState();
  if (getEffectiveTranscriptionMode(state) !== "local") {
    return;
  }

  const existingDownload =
    state.settings.aiTranscription.localModelManagement.modelDownloads[model];
  if (
    isLocalTranscriptionModelDownloadInProgress(existingDownload) ||
    downloadOwners.has(model) ||
    cancellingDownloads.has(model)
  ) {
    return;
  }
  const owner = Symbol(model);
  let markStarted!: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => {
    markStarted = resolve;
  });
  downloadStarts.set(model, started);
  downloadOwners.set(model, owner);
  bumpDownloadRevision(model);

  try {
    const sidecarManager = getLocalTranscriptionSidecarManager();
    const preferGpu = getPreferGpu(state);
    const finalStatus = await sidecarManager.downloadModel({
      model,
      preferGpu,
      onProgress: (snapshot) => {
        markStarted(true);
        if (downloadOwners.get(model) !== owner) return;
        produceAppState((draft) => {
          if (snapshot.status === "canceled") {
            delete draft.settings.aiTranscription.localModelManagement
              .modelDownloads[model];
          } else {
            draft.settings.aiTranscription.localModelManagement.modelDownloads[
              model
            ] = snapshot;
          }
        });
      },
    });

    if (downloadOwners.get(model) !== owner) return;
    if (finalStatus?.downloaded && finalStatus?.valid) {
      produceAppState((draft) => {
        delete draft.settings.aiTranscription.localModelManagement
          .modelDownloads[model];
      });
      await refreshLocalTranscriptionModelStatuses({ showErrors: false });
    }
  } catch (error) {
    if (downloadOwners.get(model) !== owner) return;
    const current =
      getAppState().settings.aiTranscription.localModelManagement
        .modelDownloads[model];
    if (current?.status !== "paused" && current?.status !== "canceled") {
      produceAppState((draft) => {
        delete draft.settings.aiTranscription.localModelManagement
          .modelDownloads[model];
      });
      showErrorSnackbar(`Unable to download '${model}' model: ${error}`);
    }
  } finally {
    markStarted(false);
    if (downloadStarts.get(model) === started) downloadStarts.delete(model);
    if (downloadOwners.get(model) === owner) downloadOwners.delete(model);
  }
};

/** Resolve a local download target before touching the sidecar. */
const getLocalDownloadContext = (model: LocalWhisperModel) => {
  const state = getAppState();
  if (getEffectiveTranscriptionMode(state) !== "local") return null;
  return {
    manager: getLocalTranscriptionSidecarManager(),
    options: { model, preferGpu: getPreferGpu(state) },
  };
};

export const pauseLocalTranscriptionModelDownload = async (
  model: LocalWhisperModel,
): Promise<void> => {
  const context = getLocalDownloadContext(model);
  if (!context) return;

  const owner = downloadOwners.get(model);
  const revision = downloadRevisions.get(model);
  const started = downloadStarts.get(model);
  try {
    if (started && !(await started)) return;
    if (downloadRevisions.get(model) !== revision) return;
    const snapshot = await context.manager.pauseModelDownload(context.options);
    if (
      downloadRevisions.get(model) !== revision ||
      downloadOwners.get(model) !== owner ||
      cancellingDownloads.has(model)
    )
      return;
    if (snapshot.status === "paused") {
      bumpDownloadRevision(model);
      downloadOwners.delete(model);
    }
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelDownloads[
        model
      ] = snapshot;
    });
  } catch (error) {
    if (downloadRevisions.get(model) === revision)
      showErrorSnackbar(`Unable to pause download for '${model}': ${error}`);
  }
};

export const resumeLocalTranscriptionModelDownload = async (
  model: LocalWhisperModel,
): Promise<void> => {
  await downloadLocalTranscriptionModel(model);
};

export const cancelLocalTranscriptionModelDownload = async (
  model: LocalWhisperModel,
): Promise<void> => {
  const context = getLocalDownloadContext(model);
  if (!context || cancellingDownloads.has(model)) return;
  const started = downloadStarts.get(model);
  cancellingDownloads.add(model);
  bumpDownloadRevision(model);
  downloadOwners.delete(model);

  try {
    if (!started || (await started))
      await context.manager.cancelModelDownload(context.options);
  } catch (error) {
    showErrorSnackbar(`Unable to cancel download for '${model}': ${error}`);
  } finally {
    produceAppState((draft) => {
      delete draft.settings.aiTranscription.localModelManagement.modelDownloads[
        model
      ];
    });
    try {
      await refreshLocalTranscriptionModelStatuses({ showErrors: false });
    } finally {
      cancellingDownloads.delete(model);
    }
  }
};

export const deleteLocalTranscriptionModel = async (
  model: LocalWhisperModel,
): Promise<LocalTranscriptionModelStatusMap | null> => {
  const state = getAppState();
  if (getEffectiveTranscriptionMode(state) !== "local") {
    return null;
  }

  if (state.settings.aiTranscription.localModelManagement.modelDeletes[model]) {
    return null;
  }

  const sidecarManager = getLocalTranscriptionSidecarManager();
  const preferGpu = getPreferGpu(state);

  produceAppState((draft) => {
    draft.settings.aiTranscription.localModelManagement.modelDeletes[model] =
      true;
  });

  try {
    await sidecarManager.deleteModel({ model, preferGpu });
    return await refreshLocalTranscriptionModelStatuses({ showErrors: false });
  } catch (error) {
    showErrorSnackbar(`Unable to delete '${model}' model: ${error}`);
    return null;
  } finally {
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelDeletes[model] =
        false;
    });
  }
};
