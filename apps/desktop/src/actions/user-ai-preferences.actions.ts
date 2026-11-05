import { type AgentMode, Nullable } from "@maus-inc/types";
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

export const setPreferredTranscriptionMode = async (
  mode: TranscriptionMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionMode = mode;
  });
};

export const setPreferredTranscriptionApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionApiKeyId = id;
  });
};

export const setPreferredTranscriptionDevice = async (
  device: string,
): Promise<void> => {
  const normalizedDevice = normalizeTranscriptionDevice(device);
  const gpuEnumerationEnabled =
    isGpuPreferredTranscriptionDevice(normalizedDevice);

  produceAppState((draft) => {
    draft.settings.aiTranscription.device = normalizedDevice;
    draft.settings.aiTranscription.gpuEnumerationEnabled =
      gpuEnumerationEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionDevice = normalizedDevice;
    preferences.gpuEnumerationEnabled = gpuEnumerationEnabled;
  });
};

export const setPreferredTranscriptionModelSize = async (
  modelSize: string,
): Promise<void> => {
  const normalizedModelSize = normalizeLocalWhisperModel(modelSize);
  produceAppState((draft) => {
    draft.settings.aiTranscription.modelSize = normalizedModelSize;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionModelSize = normalizedModelSize;
  });
};

export const setGpuEnumerationEnabled = async (
  enabled: boolean,
): Promise<void> => {
  const nextEnabled = supportsGpuTranscriptionDevice() && enabled;
  produceAppState((draft) => {
    draft.settings.aiTranscription.gpuEnumerationEnabled = nextEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.gpuEnumerationEnabled = nextEnabled;
  });
};

export const setPreferredPostProcessingMode = async (
  mode: PostProcessingMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingMode = mode;
  });
};

export const setPreferredPostProcessingApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingApiKeyId = id;
  });
};

export const setPreferredAgentMode = async (mode: AgentMode): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentMode = mode;
  });
};

export const setPreferredAgentModeApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentModeApiKeyId = id;
  });
};
