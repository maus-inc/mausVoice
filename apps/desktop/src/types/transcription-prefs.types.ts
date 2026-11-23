import type { ApiKeyProvider } from "@maus-inc/types";

type BaseTranscriptionPrefs = {
  warnings: string[];
};

export type LocalTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "local";
  gpuEnumerationEnabled: boolean;
  transcriptionDevice: string | null;
  transcriptionModelSize: string | null;
};

export type ApiTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "api";
  provider: ApiKeyProvider;
  apiKeyId: string;
  apiKeyValue: string;
  transcriptionModel: string | null;
};

export type TranscriptionPrefs =
  LocalTranscriptionPrefs | ApiTranscriptionPrefs;
