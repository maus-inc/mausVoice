import type { UnlistenFn } from "@tauri-apps/api/event";
import { transcribeAudio } from "../actions/transcribe.actions";
import type { SettingsTranscriptionState } from "../state/settings.state";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import { getLocalTranscriptionSidecarManager } from "../sidecars";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { listenToAudioChunks } from "./audio-chunk-events";
import {
  createActionPretranscriber,
  LOCAL_PRETRANSCRIPTION,
  logPretranscription,
} from "./batch-transcription-session";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";
import { SessionAbortScope } from "./session-abort-scope";

type LocalSessionContext = {
  prompt: string;
  hallucinationFilterEnabled: boolean;
};

/**
 * Local transcription without a live streaming session.
 *
 * The sidecar's streaming endpoint only buffers appended samples; it decodes
 * the whole buffer when the session is finalized, and it never reports interim
 * text. Keeping one open for the recording therefore bought no overlap: it
 * inferred the entire recording at stop, which is exactly what the span path
 * already does incrementally, so the same audio was inferred twice whenever a
 * span was cut. One owner per recording now: the pretranscriber, with a
 * single whole-recording request when it has nothing usable.
 */
export class LocalTranscriptionSession implements TranscriptionSession {
  private unlisten: UnlistenFn | null = null;
  private pretranscriber: PauseChunkedPretranscriber | null = null;
  private context: LocalSessionContext | null = null;
  /** Per recording, not per session instance: `onRecordingStart` re-arms it. */
  private abortScope = new SessionAbortScope();
  private startupWarnings: string[] = [];

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.cleanup();
    // A previous recording may have aborted the scope; this one needs a live signal.
    this.abortScope = new SessionAbortScope();
    this.startupWarnings = [];

    try {
      const state = getAppState();
      const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
      const prompt = buildLocalizedTranscriptionPrompt({
        entries: collectDictionaryEntries(state),
        dictationLanguage,
        state,
      });

      const hallucinationFilterEnabled =
        state.userPrefs?.hallucinationFilterEnabled !== false;
      // Load the model before the user speaks, so neither the first span nor
      // the whole-recording request pays for a cold start or a download after
      // they have already stopped.
      await this.warmModel(state.settings.aiTranscription);

      this.context = { prompt, hallucinationFilterEnabled };
      const pretranscriber = createActionPretranscriber(sampleRate, {
        config: LOCAL_PRETRANSCRIPTION,
        hallucinationFilterEnabled,
        selectText: (result) => result.sanitizedTranscript,
      });
      this.pretranscriber = pretranscriber;
      this.unlisten = await listenToAudioChunks((samples, offset) => {
        pretranscriber.push(samples, offset);
      });
    } catch (error) {
      const message = this.toErrorMessage(error);
      this.startupWarnings.push(
        `Local pretranscription unavailable, transcribing the whole recording (${message})`,
      );
      getLogger().warning(
        `[local-session] start failed, transcribing the whole recording (${message})`,
      );
      this.cleanup();
    }
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const warnings = [...this.startupWarnings];
    const pretranscriber = this.pretranscriber;

    try {
      const pretranscribed = await this.finishPretranscription(audio, warnings);
      if (pretranscribed) return pretranscribed;
      // Cancelled mid-finalize: the session is already torn down.
      if (pretranscriber?.isDisposed || this.abortScope.isAborted) {
        return { rawTranscript: null, metadata: {}, warnings };
      }
      return await this.transcribeWholeRecording(audio, warnings);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    this.abortScope.abort();
    getLogger().info(
      `[local-session] cleanup (hasUnlisten=${!!this.unlisten}, hasPretranscriber=${!!this.pretranscriber})`,
    );
    this.unlisten?.();
    this.unlisten = null;
    this.pretranscriber?.dispose();
    this.pretranscriber = null;
    this.context = null;
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  /**
   * Long recordings are transcribed span by span at natural pauses while the
   * user speaks; only the tail after the last pause is left at stop. Returns
   * null (transcribe the whole recording) when no span was cut or the spans
   * cannot be trusted.
   */
  private async finishPretranscription(
    audio: StopRecordingResponse,
    warnings: string[],
  ): Promise<TranscriptionSessionResult | null> {
    const pretranscriber = this.pretranscriber;
    if (!pretranscriber || pretranscriber.chunkCount === 0) return null;
    const started = performance.now();
    const result = await pretranscriber.finish(audio);
    if (!result) {
      getLogger().warning(
        "[local-session] pretranscription unusable, transcribing the whole recording",
      );
      return null;
    }
    logPretranscription("local-session", result, performance.now() - started);
    return {
      rawTranscript: result.text.trim() || null,
      metadata: {
        ...result.metadata,
        transcriptionMode: "local",
        transcriptionPrompt: this.context?.prompt ?? null,
      },
      warnings: [...warnings, ...result.warnings],
    };
  }

  private async transcribeWholeRecording(
    audio: StopRecordingResponse,
    warnings: string[],
  ): Promise<TranscriptionSessionResult> {
    const payloadSamples = audio.samples ?? [];
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || payloadSamples.length === 0) {
      getLogger().warning(
        `[local-session] skipping transcription (rate=${rate}, samples=${payloadSamples.length})`,
      );
      return {
        rawTranscript: null,
        metadata: {
          transcriptionMode: "local",
          transcriptionPrompt: this.context?.prompt ?? null,
        },
        warnings,
      };
    }

    getLogger().info(
      `[local-session] transcribing the whole recording (${payloadSamples.length} samples at ${rate}Hz)`,
    );
    try {
      const result = await transcribeAudio({
        samples: payloadSamples,
        sampleRate: rate,
        hallucinationFilterEnabled: this.context?.hallucinationFilterEnabled,
        signal: this.abortScope.signal,
      });
      getLogger().info(
        `[local-session] transcription complete (${result.rawTranscript.length} chars)`,
      );

      return {
        rawTranscript: result.rawTranscript,
        metadata: result.metadata,
        warnings: [...warnings, ...result.warnings],
      };
    } catch (error) {
      // A discard aborts the request on purpose, so it returns nothing rather
      // than surfacing an error the user did not cause.
      if (this.abortScope.isAborted) {
        getLogger().info(
          "[local-session] transcription cancelled: the dictation was discarded",
        );
        return {
          rawTranscript: null,
          metadata: {
            transcriptionMode: "local",
            transcriptionPrompt: this.context?.prompt ?? null,
          },
          warnings,
        };
      }
      throw error;
    }
  }

  /**
   * Mirrors the readiness check the sidecar performs before any request, so a
   * missing model is downloaded while the user is still speaking.
   */
  private async warmModel(settings: SettingsTranscriptionState): Promise<void> {
    const manager = getLocalTranscriptionSidecarManager();
    const model = normalizeLocalWhisperModel(settings.modelSize);
    const preferGpu = isGpuPreferredTranscriptionDevice(settings.device);
    const status = await manager.getModelStatus({ model, preferGpu });
    if (!status.downloaded || !status.valid) {
      await manager.downloadModel({ model, preferGpu });
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
