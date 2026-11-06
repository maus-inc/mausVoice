import { showToast } from "../actions/toast.actions";
import {
  type TranscribeAudioResult,
  transcribeAudio,
} from "../actions/transcribe.actions";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import {
  PauseChunkedPretranscriber,
  type PauseChunkingConfig,
  type PretranscriptionResult,
} from "./pause-chunked-pretranscriber";
import {
  failedCaptureResult,
  usableRecordingAudio,
  wholeRecordingResult,
} from "./recording-transcription.utils";
import { SessionAbortScope } from "./session-abort-scope";

/**
 * Cloud requests are billed and rate limited per call (Groq bills a 10 s
 * minimum), so spans stay well above that while keeping the post-stop tail
 * short.
 */
const CLOUD_PRETRANSCRIPTION: PauseChunkingConfig = {
  minChunkSec: 12,
  minPauseMs: 450,
};

/**
 * Whisper pads every call to a 30 s window, so local spans close to that
 * length avoid paying for extra encoder passes.
 */
export const LOCAL_PRETRANSCRIPTION: PauseChunkingConfig = {
  minChunkSec: 24,
  minPauseMs: 450,
};

/**
 * Pretranscriber backed by the regular `transcribeAudio` action, so every
 * span goes through the same provider dispatch, prompt, silence gate, and
 * hallucination handling as a whole-recording request.
 */
export const createActionPretranscriber = (
  sampleRate: number,
  {
    config,
    hallucinationFilterEnabled,
    selectText,
  }: {
    config: PauseChunkingConfig;
    hallucinationFilterEnabled?: boolean;
    /** Which transcript field represents a span; mirrors the session's whole-recording path. */
    selectText: (result: TranscribeAudioResult) => string;
  },
): PauseChunkedPretranscriber =>
  new PauseChunkedPretranscriber(
    sampleRate,
    async (samples, rate, signal) => {
      const result = await transcribeAudio({
        samples,
        sampleRate: rate,
        hallucinationFilterEnabled,
        signal,
      });
      return {
        text: selectText(result),
        metadata: result.metadata,
        warnings: result.warnings,
      };
    },
    config,
  );

const logPretranscription = (
  label: string,
  result: PretranscriptionResult,
  waitMs: number,
): void => {
  getLogger().info(
    `[${label}] pretranscribed ${result.chunkCount} spans; post-stop wait ${Math.round(waitMs)}ms (${result.text.length} chars)`,
  );
};

/** Finish sealed spans once; a missing or unusable result triggers full transcription. */
export const finishPretranscriber = async (
  pretranscriber: PauseChunkedPretranscriber | null,
  audio: StopRecordingResponse,
  label: string,
  warning: string,
): Promise<PretranscriptionResult | null> => {
  if (!pretranscriber || pretranscriber.chunkCount === 0) return null;
  // `finish` seals the pretranscriber while its final tail is processed.
  const started = performance.now();
  const result = await pretranscriber.finish(audio);
  if (!result) {
    getLogger().warning(warning);
    return null;
  }
  logPretranscription(label, result, performance.now() - started);
  return result;
};

/**
 * Returned instead of a transcript when there is nothing to send or the run
 * was cancelled. Built fresh per call so a caller mutating the result cannot
 * reach another caller's object.
 */
const emptyResult = (): TranscriptionSessionResult => ({
  rawTranscript: null,
  metadata: {},
  warnings: [],
});

/**
 * Batch transcription session. Audio is transcribed with one request after
 * recording stops, except that long recordings are pretranscribed at natural
 * pauses while the user speaks so only the tail remains at stop.
 * Only handles transcription, not post-processing.
 */
export class BatchTranscriptionSession implements TranscriptionSession {
  private pretranscriber: PauseChunkedPretranscriber | null = null;
  /** Per recording, not per session instance: `onRecordingStart` re-arms it. */
  private abortScope = new SessionAbortScope();
  private finalizing = false;
  private generation = 0;

  onBeforeRecordingStart(): Promise<void> {
    this.resetForRecording();
    this.finalizing = false;
    return Promise.resolve();
  }

  onRecordingStart(sampleRate: number): Promise<void> {
    if (this.finalizing) return Promise.resolve();
    this.resetForRecording();
    this.pretranscriber = createActionPretranscriber(sampleRate, {
      config: CLOUD_PRETRANSCRIPTION,
      selectText: (result) => result.rawTranscript,
    });
    return Promise.resolve();
  }

  /**
   * The component owns the `audio_chunk` registration and supplies the
   * absolute sample index, which the pretranscriber needs to align the live
   * stream with the final recording.
   */
  writeAudioChunk(chunk: Float32Array, offset: number): void {
    if (!this.finalizing) this.pretranscriber?.push(chunk, offset);
  }

  async finalize(
    audio: StopRecordingResponse,
    options?: { toneId?: string | null },
  ): Promise<TranscriptionSessionResult> {
    this.finalizing = true;
    const generation = this.generation;
    const scope = this.abortScope;
    const pretranscriber = this.pretranscriber;
    try {
      if (scope.isAborted) return emptyResult();
      if (audio.captureFailed) return failedCaptureResult();
      const pretranscribed = await this.finishPretranscription(
        audio,
        pretranscriber,
      );
      if (scope.isAborted) return emptyResult();
      if (pretranscribed) return pretranscribed;
      // Cancelled mid-finalize: don't pay for a whole-recording request nobody reads.
      if (pretranscriber?.isDisposed) return emptyResult();
      return await this.transcribeWholeRecording(audio, options, scope);
    } finally {
      if (generation === this.generation) this.cleanup();
    }
  }

  /** Tears down the previous recording and gives this one a live abort scope. */
  private resetForRecording(): void {
    this.cleanup();
    this.abortScope = new SessionAbortScope();
  }

  cleanup(): void {
    this.generation += 1;
    this.abortScope.abort();
    this.pretranscriber?.dispose();
    this.pretranscriber = null;
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  private async finishPretranscription(
    audio: StopRecordingResponse,
    pretranscriber: PauseChunkedPretranscriber | null,
  ): Promise<TranscriptionSessionResult | null> {
    const result = await finishPretranscriber(
      pretranscriber,
      audio,
      "batch",
      "Batch session: pretranscription unusable, transcribing the whole recording",
    );
    if (!result) return null;
    return {
      rawTranscript: result.text,
      metadata: result.metadata,
      warnings: result.warnings,
    };
  }

  private async transcribeWholeRecording(
    audio: StopRecordingResponse,
    options: { toneId?: string | null } | undefined,
    scope: SessionAbortScope,
  ): Promise<TranscriptionSessionResult> {
    const recording = usableRecordingAudio(audio);
    if (!recording) {
      getLogger().warning(
        `Batch session: skipping transcription (rate=${audio.sampleRate}, samples=${audio.samples?.length ?? 0})`,
      );
      return emptyResult();
    }

    const { samples: payloadSamples, sampleRate: rate } = recording;

    const warnings: string[] = [];

    try {
      getLogger().info(
        `Batch transcription: ${payloadSamples.length} samples at ${rate}Hz`,
      );
      const result = await transcribeAudio({
        samples: payloadSamples,
        sampleRate: rate,
        toneId: options?.toneId ?? null,
        signal: scope.signal,
      });
      if (scope.isAborted) return emptyResult();

      return wholeRecordingResult(
        result,
        warnings,
        `Batch transcription result: ${result.rawTranscript.length} chars`,
      );
    } catch {
      // A discard aborts the request on purpose. That is not a failure, so it
      // must not reach the user as "Transcription failed".
      if (scope.isAborted) {
        getLogger().info(
          "Batch transcription cancelled: the dictation was discarded",
        );
        return emptyResult();
      }
      getLogger().error("Failed to transcribe audio");
      warnings.push("Transcription failed");
      showToast({
        message: "Transcription failed",
        toastType: "error",
      });

      return {
        rawTranscript: null,
        metadata: {},
        warnings,
      };
    }
  }
}
