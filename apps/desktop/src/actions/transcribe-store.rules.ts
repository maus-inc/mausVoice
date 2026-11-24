import type { AppState } from "../state/app.state";
import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../types/transcription-metadata.types";
import { orFalse } from "../utils/nullable.utils";
type RemoteStatus = "sent" | "received" | null | undefined;

export type StoragePreferences = {
  incognitoEnabled: boolean;
  includeInStats: boolean;
  preserveAudioOnFailure: boolean;
};

export const readStoragePreferences = (state: AppState): StoragePreferences => {
  const prefs = state.userPrefs;
  return {
    incognitoEnabled: orFalse(prefs?.incognitoModeEnabled),
    includeInStats: orFalse(prefs?.incognitoModeIncludeInStats),
    preserveAudioOnFailure: prefs?.preserveAudioOnFailure ?? true,
  };
};

/**
 * Counting words is an incognito-only option, and an ephemeral session never
 * opted into usage statistics. A received utterance was counted remotely.
 */
export const shouldRecordSuppressedUsage = (input: {
  wordsAdded: number;
  transcriptionFailed: boolean;
  remoteStatus: RemoteStatus;
  includeInStats: boolean;
  incognitoEnabled: boolean;
  ephemeralSessionActive: boolean;
}): boolean =>
  input.wordsAdded > 0 &&
  !input.transcriptionFailed &&
  input.remoteStatus !== "received" &&
  input.includeInStats &&
  input.incognitoEnabled &&
  !input.ephemeralSessionActive;

/**
 * A failed recording keeps its WAV only when the user opted in, so no audio
 * file is left on disk with no row pointing at it.
 */
export const shouldPersistAudioSnapshot = (input: {
  rate: number;
  sampleCount: number;
  transcriptionFailed: boolean;
  preserveAudioOnFailure: boolean;
}): boolean =>
  input.rate > 0 &&
  input.sampleCount > 0 &&
  !(input.transcriptionFailed && !input.preserveAudioOnFailure);

/** Only a saved, locally counted utterance needs the usage refresh. */
export const shouldRefreshUsageAfterSave = (input: {
  wordsAdded: number;
  transcriptionFailed: boolean;
  remoteStatus: RemoteStatus;
}): boolean =>
  input.wordsAdded > 0 &&
  !input.transcriptionFailed &&
  input.remoteStatus !== "received";

export const buildProviderTimingKey = (
  transcription: TranscribeAudioMetadata,
  postProcess: PostProcessMetadata,
): string =>
  [
    transcription.transcriptionMode ?? "unknown",
    transcription.modelSize ?? "",
    transcription.inferenceDevice ?? "",
    postProcess.postProcessMode ?? "",
  ].join("|");
