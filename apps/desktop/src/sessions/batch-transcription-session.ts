import type { UnlistenFn } from "@tauri-apps/api/event";
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
import { listenToAudioChunks } from "./audio-chunk-events";
import { SessionAbortScope } from "./session-abort-scope";
import {
  PauseChunkedPretranscriber,
  type PauseChunkingConfig,
  type PretranscriptionResult,
} from "./pause-chunked-pretranscriber";

/**
 * Cloud requests are billed and rate limited per call (Groq bills a 10 s
 * minimum), so spans stay well above that while keeping the post-stop tail
 * short.
 */
export const CLOUD_PRETRANSCRIPTION: PauseChunkingConfig = {
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

type PretranscriptionOptions = {
  config: PauseChunkingConfig;
  hallucinationFilterEnabled?: boolean;
  /** Which transcript field represents a span; mirrors the session's whole-recording path. */
  selectText: (result: TranscribeAudioResult) => string;
};

/**
 * Pretranscriber backed by the regular `transcribeAudio` action, so every
 * span goes through the same provider dispatch, prompt, silence gate, and
 * hallucination handling as a whole-recording request.
 */
export const createActionPretranscriber = (
  sampleRate: number,
  { config, hallucinationFilterEnabled, selectText }: PretranscriptionOptions,
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

export const logPretranscription = (
  label: string,
  result: PretranscriptionResult,
  waitMs: number,
): void => {
  getLogger().info(
    `[${label}] pretranscribed ${result.chunkCount} spans; post-stop wait ${Math.round(waitMs)}ms (${result.text.length} chars)`,
  );
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
  private unlisten: UnlistenFn | null = null;
  /** Per recording, not per session instance: `onRecordingStart` re-arms it. */
  private abortScope = new SessionAbortScope();

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.cleanup();
    // A previous recording may have aborted the scope; this one needs a live signal.
    this.abortScope = new SessionAbortScope();
    const pretranscriber = createActionPretranscriber(sampleRate, {
      config: CLOUD_PRETRANSCRIPTION,
      selectText: (result) => result.rawTranscript,
    });
    this.pretranscriber = pretranscriber;
    try {
      this.unlisten = await listenToAudioChunks((samples, offset) =>
        pretranscriber.push(samples, offset),
      );
    } catch (error) {
      getLogger().verbose(
        `Batch session: pretranscription unavailable (${error})`,
      );
    }
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    try {
      const pretranscriber = this.pretranscriber;
      const pretranscribed = await this.finishPretranscription(audio);
      if (pretranscribed) return pretranscribed;
      // Cancelled mid-finalize: don't pay for a whole-recording request nobody reads.
      if (pretranscriber?.isDisposed || this.abortScope.isAborted) {
        return emptyResult();
      }
      return await this.transcribeWholeRecording(audio);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    this.abortScope.abort();
    this.unlisten?.();
    this.unlisten = null;
    this.pretranscriber?.dispose();
    this.pretranscriber = null;
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  private async finishPretranscription(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult | null> {
    const pretranscriber = this.pretranscriber;
    if (!pretranscriber || pretranscriber.chunkCount === 0) return null;
    this.unlisten?.();
    this.unlisten = null;
    const started = performance.now();
    const result = await pretranscriber.finish(audio);
    if (!result) {
      getLogger().warning(
        "Batch session: pretranscription unusable, transcribing the whole recording",
      );
      return null;
    }
    logPretranscription("batch", result, performance.now() - started);
    return {
      rawTranscript: result.text,
      metadata: result.metadata,
      warnings: result.warnings,
    };
  }

  private async transcribeWholeRecording(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const payloadSamples = audio.samples ?? [];
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || payloadSamples.length === 0) {
      getLogger().warning(
        `Batch session: skipping transcription (rate=${rate}, samples=${payloadSamples.length})`,
      );
      return emptyResult();
    }

    const warnings: string[] = [];

    try {
      getLogger().info(
        `Batch transcription: ${payloadSamples.length} samples at ${rate}Hz`,
      );
      const result = await transcribeAudio({
        samples: payloadSamples,
        sampleRate: rate,
        signal: this.abortScope.signal,
      });

      getLogger().info(
        `Batch transcription result: ${result.rawTranscript.length} chars`,
      );
      return {
        rawTranscript: result.rawTranscript,
        metadata: result.metadata,
        warnings: [...warnings, ...result.warnings],
      };
    } catch (error) {
      // A discard aborts the request on purpose. That is not a failure, so it
      // must not reach the user as "Transcription failed".
      if (this.abortScope.isAborted) {
        getLogger().info(
          "Batch transcription cancelled: the dictation was discarded",
        );
        return emptyResult();
      }
      getLogger().error(`Failed to transcribe audio: ${error}`);
      const message = String(error);
      if (message) {
        warnings.push(`Transcription failed: ${message}`);
        showToast({
          message: "Transcription failed",
          toastType: "error",
        });
      }

      return {
        rawTranscript: null,
        metadata: {},
        warnings,
      };
    }
  }
}
