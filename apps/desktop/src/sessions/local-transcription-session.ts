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
import {
  createActionPretranscriber,
  LOCAL_PRETRANSCRIPTION,
  logPretranscription,
} from "./batch-transcription-session";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";
import type { RecordingAudioRelay } from "./recording-audio-relay";
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
  readonly consumesAudioChunkRelay = true;
  private audioRelay: RecordingAudioRelay | null = null;
  private pretranscriber: PauseChunkedPretranscriber | null = null;
  private context: LocalSessionContext | null = null;
  /** Per recording, not per session instance: `onRecordingStart` re-arms it. */
  private abortScope = new SessionAbortScope();
  private startupWarnings: string[] = [];

  attachAudioChunkRelay(relay: RecordingAudioRelay): void {
    this.audioRelay = relay;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.resetForRecording();
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
      // The model is loaded while the user is already speaking, so the relay
      // holds the audio this wait would otherwise lose. Nothing below runs
      // until a sink is bound to the relay.
      await this.warmModel(state.settings.aiTranscription);

      this.context = { prompt, hallucinationFilterEnabled };
      const relay = this.audioRelay;
      if (!relay) {
        throw new Error("no audio chunk stream was registered before capture");
      }
      const pretranscriber = createActionPretranscriber(sampleRate, {
        config: LOCAL_PRETRANSCRIPTION,
        hallucinationFilterEnabled,
        selectText: (result) => result.sanitizedTranscript,
      });
      this.pretranscriber = pretranscriber;
      // Binding replays everything the recorder emitted since capture began,
      // so the spans still cover the recording from its first sample.
      if (
        !relay.bind((samples, offset) => {
          pretranscriber.push(samples, offset);
        })
      ) {
        throw new Error(
          "the live audio stream overflowed before this session bound to it",
        );
      }
    } catch (error) {
      const message = this.toErrorMessage(error);
      this.startupWarnings.push(
        `Local pretranscription unavailable, transcribing the whole recording (${message})`,
      );
      getLogger().warning(
        `[local-session] start failed, transcribing the whole recording (${message})`,
      );
      // The recording is still live, it just has no pretranscriber, so the
      // scope must stay live for the whole-recording request at stop. Tearing
      // it down here would cancel the one request the user still needs.
      this.resetForRecording();
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

  /**
   * Tears down the previous recording and gives this one a live abort scope.
   * The relay survives it: the capture entry point handed it over before
   * `start_recording`, and this recording is what it is still holding audio
   * for.
   */
  private resetForRecording(): void {
    this.teardown();
    this.abortScope = new SessionAbortScope();
  }

  cleanup(): void {
    this.teardown();
    this.audioRelay?.release();
    this.audioRelay = null;
  }

  private teardown(): void {
    this.abortScope.abort();
    getLogger().info(
      `[local-session] cleanup (hasPretranscriber=${!!this.pretranscriber})`,
    );
    this.audioRelay?.unbind();
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
