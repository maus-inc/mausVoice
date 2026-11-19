import {
  type AgentMode,
  Nullable,
  type UserPreferences,
} from "@maus-inc/types";
import type { AppState } from "../state/app.state";
import { produceAppState } from "../store";
import {
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { updateUserPreferences } from "./user-actions-core";

/**
 * Apply the settings-slice update first, then persist the matching preference
 * write. The two stores move together in this order everywhere below; only the
 * field-specific mutations differ per setter.
 */
const persistAiPreference = (
  updateSettings: (draft: AppState) => void,
  applyToPreferences: (preferences: UserPreferences) => void,
): Promise<void> => {
  produceAppState(updateSettings);
  return updateUserPreferences(applyToPreferences);
};

export const setPreferredTranscriptionMode = (
  mode: TranscriptionMode,
): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.aiTranscription.mode = mode;
    },
    (preferences) => {
      preferences.transcriptionMode = mode;
    },
  );

export const setPreferredTranscriptionApiKeyId = (
  id: Nullable<string>,
): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.aiTranscription.selectedApiKeyId = id;
    },
    (preferences) => {
      preferences.transcriptionApiKeyId = id;
    },
  );

export const setPreferredTranscriptionDevice = async (
  device: string,
): Promise<void> => {
  const normalizedDevice = normalizeTranscriptionDevice(device);
  const gpuEnumerationEnabled =
    isGpuPreferredTranscriptionDevice(normalizedDevice);

  await persistAiPreference(
    (draft) => {
      draft.settings.aiTranscription.device = normalizedDevice;
      draft.settings.aiTranscription.gpuEnumerationEnabled =
        gpuEnumerationEnabled;
    },
    (preferences) => {
      preferences.transcriptionDevice = normalizedDevice;
      preferences.gpuEnumerationEnabled = gpuEnumerationEnabled;
    },
  );
};

export const setPreferredTranscriptionModelSize = (
  modelSize: string,
): Promise<void> => {
  const normalizedModelSize = normalizeLocalWhisperModel(modelSize);
  return persistAiPreference(
    (draft) => {
      draft.settings.aiTranscription.modelSize = normalizedModelSize;
    },
    (preferences) => {
      preferences.transcriptionModelSize = normalizedModelSize;
    },
  );
};

export const setGpuEnumerationEnabled = (enabled: boolean): Promise<void> => {
  const nextEnabled = supportsGpuTranscriptionDevice() && enabled;
  return persistAiPreference(
    (draft) => {
      draft.settings.aiTranscription.gpuEnumerationEnabled = nextEnabled;
    },
    (preferences) => {
      preferences.gpuEnumerationEnabled = nextEnabled;
    },
  );
};

export const setPreferredPostProcessingMode = (
  mode: PostProcessingMode,
): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.aiPostProcessing.mode = mode;
    },
    (preferences) => {
      preferences.postProcessingMode = mode;
    },
  );

export const setPreferredPostProcessingApiKeyId = (
  id: Nullable<string>,
): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.aiPostProcessing.selectedApiKeyId = id;
    },
    (preferences) => {
      preferences.postProcessingApiKeyId = id;
    },
  );

export const setPreferredAgentMode = (mode: AgentMode): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.agentMode.mode = mode;
    },
    (preferences) => {
      preferences.agentMode = mode;
    },
  );

export const setPreferredAgentModeApiKeyId = (
  id: Nullable<string>,
): Promise<void> =>
  persistAiPreference(
    (draft) => {
      draft.settings.agentMode.selectedApiKeyId = id;
    },
    (preferences) => {
      preferences.agentModeApiKeyId = id;
    },
  );
