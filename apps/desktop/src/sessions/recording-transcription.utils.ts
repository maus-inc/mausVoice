import type { TranscribeAudioResult } from "../actions/transcribe.actions";
import { getLogger } from "../utils/log.utils";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";

const CAPTURE_FAILED_WARNING =
  "Audio capture stopped unexpectedly; recording may be incomplete";

export const failedCaptureResult = (): TranscriptionSessionResult => ({
  rawTranscript: null,
  metadata: {},
  warnings: [CAPTURE_FAILED_WARNING],
});

/** Check the same audio boundary before either whole-recording request. */
export const usableRecordingAudio = (
  audio: StopRecordingResponse,
): { samples: number[] | Float32Array; sampleRate: number } | null => {
  const samples = audio.samples ?? [];
  const sampleRate = audio.sampleRate;
  if (
    audio.captureFailed ||
    sampleRate == null ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    samples.length === 0
  )
    return null;
  return { samples, sampleRate };
};

/** Preserve provider metadata and append its warnings after startup warnings. */
export const wholeRecordingResult = (
  result: TranscribeAudioResult,
  warnings: string[],
  logMessage: string,
): TranscriptionSessionResult => {
  getLogger().info(logMessage);
  return {
    rawTranscript: result.rawTranscript,
    metadata: result.metadata,
    warnings: [...warnings, ...result.warnings],
  };
};
