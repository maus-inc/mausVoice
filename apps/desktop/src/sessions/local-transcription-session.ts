import { transcribeAudio } from "../actions/transcribe.actions";
import { filterLocalTranscriptionSegments } from "../repos/transcribe-audio.repo";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import {
  type LocalSidecarStreamingSession,
  getLocalTranscriptionSidecarManager,
  isSessionNotFoundError,
} from "../sidecars";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { mapDictationLanguageToWhisperLanguage } from "../utils/language.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import {
  createActionPretranscriber,
  LOCAL_PRETRANSCRIPTION,
  logPretranscription,
} from "./batch-transcription-session";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";

type LocalSessionContext = {
  prompt: string;
  hallucinationFilterEnabled: boolean;
};

export class LocalTranscriptionSession implements TranscriptionSession {
  private session: LocalSidecarStreamingSession | null = null;
  private context: LocalSessionContext | null = null;
  private pretranscriber: PauseChunkedPretranscriber | null = null;
  private startupWarnings: string[] = [];

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.cleanup();
    this.startupWarnings = [];

    try {
      const state = getAppState();
      const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
      const whisperLanguage =
        mapDictationLanguageToWhisperLanguage(dictationLanguage);
      const prompt = buildLocalizedTranscriptionPrompt({
        entries: collectDictionaryEntries(state),
        dictationLanguage,
        state,
      });

      const hallucinationFilterEnabled =
        state.userPrefs?.hallucinationFilterEnabled !== false;
      const settings = state.settings.aiTranscription;
      const sidecarSession =
        await getLocalTranscriptionSidecarManager().createStreamingSession({
          model: normalizeLocalWhisperModel(settings.modelSize),
          preferGpu: isGpuPreferredTranscriptionDevice(settings.device),
          sampleRate,
          language: whisperLanguage,
          initialPrompt: prompt || undefined,
          deviceId: getTranscriptionSidecarDeviceId(settings.device),
          hallucinationFilterEnabled,
        });

      this.session = sidecarSession;
      this.context = { prompt, hallucinationFilterEnabled };
      this.pretranscriber = createActionPretranscriber(sampleRate, {
        config: LOCAL_PRETRANSCRIPTION,
        hallucinationFilterEnabled,
        selectText: (result) => result.sanitizedTranscript,
      });
    } catch (error) {
      const message = this.toErrorMessage(error);
      this.startupWarnings.push(
        `Local streaming session unavailable, falling back to batch mode (${message})`,
      );
      getLogger().warning(
        `[local-stream-session] start failed, falling back (${message})`,
      );
      this.cleanup();
    }
  }

  /**
   * One live chunk, two consumers: the sidecar's streaming session and the
   * pause-chunked pretranscriber. The component owns the `audio_chunk`
   * registration and supplies the absolute sample index, which the
   * pretranscriber needs to align the live stream with the final recording.
   */
  writeAudioChunk(chunk: Float32Array, offset: number): void {
    this.session?.writeAudioChunk(chunk);
    this.pretranscriber?.push(chunk, offset);
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const warnings = [...this.startupWarnings];

    const pretranscriber = this.pretranscriber;
    const pretranscribed = await this.finishPretranscription(audio, warnings);
    if (pretranscribed) {
      this.cleanup();
      return pretranscribed;
    }
    // Cancelled mid-finalize: the session is already torn down.
    if (pretranscriber?.isDisposed) {
      return { rawTranscript: null, metadata: {}, warnings };
    }

    if (!this.session) {
      getLogger().info(
        `[local-stream-session] no streaming session, using batch fallback`,
      );
      return await this.finalizeWithBatchFallback(audio, warnings);
    }

    try {
      getLogger().info(`[local-stream-session] finalizing streaming session`);
      const output = await this.session.finalize();
      const segments = output.segments ?? [];
      // Honor the same preference snapshot sent to the sidecar. ONNX has no
      // probability metadata, so retain its text. With filtering enabled,
      // keep an empty filtered result rather than reviving dropped segments.
      const filteredText =
        this.context?.hallucinationFilterEnabled === false ||
        segments.length === 0
          ? (output.text ?? "")
          : filterLocalTranscriptionSegments(segments);
      getLogger().info(
        `[local-stream-session] streaming finalize succeeded (${filteredText.length} chars)`,
      );
      return {
        rawTranscript: filteredText.trim() || null,
        metadata: {
          modelSize: output.model,
          inferenceDevice: output.inferenceDevice,
          transcriptionMode: "local",
          transcriptionPrompt: this.context?.prompt ?? null,
          transcriptionDurationMs: Math.round(output.durationMs),
        },
        warnings,
      };
    } catch (error) {
      const message = this.toErrorMessage(error);
      const errorName = error instanceof Error ? error.name : typeof error;
      const lostSession = isSessionNotFoundError(error)
        ? " (streaming session lost on the sidecar; batch fallback will transcribe from the retained audio)"
        : "";
      warnings.push(
        `Local streaming transcription failed, falling back to batch mode (${message})${lostSession}`,
      );
      getLogger().warning(
        `[local-stream-session] finalize failed [${errorName}], falling back to batch (${message})${lostSession}`,
      );
      return await this.finalizeWithBatchFallback(audio, warnings);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    getLogger().info(
      `[local-stream-session] cleanup (hasSession=${!!this.session})`,
    );
    this.session?.cleanup();
    this.session = null;
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
   * null (keep the streaming/batch path) when no span was cut or the spans
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
        "[local-stream-session] pretranscription unusable, finalizing the full recording",
      );
      return null;
    }
    logPretranscription(
      "local-stream-session",
      result,
      performance.now() - started,
    );
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

  private async finalizeWithBatchFallback(
    audio: StopRecordingResponse,
    warnings: string[],
  ): Promise<TranscriptionSessionResult> {
    const payloadSamples = audio.samples ?? [];
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || payloadSamples.length === 0) {
      getLogger().warning(
        `[local-stream-session] batch fallback: skipping transcription (rate=${rate}, samples=${payloadSamples.length})`,
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
      `[local-stream-session] batch fallback: transcribing ${payloadSamples.length} samples at ${rate}Hz`,
    );
    const result = await transcribeAudio({
      samples: payloadSamples,
      sampleRate: rate,
      hallucinationFilterEnabled: this.context?.hallucinationFilterEnabled,
    });
    getLogger().info(
      `[local-stream-session] batch fallback: transcription complete (${result.rawTranscript.length} chars)`,
    );

    return {
      rawTranscript: result.rawTranscript,
      metadata: result.metadata,
      warnings: [...warnings, ...result.warnings],
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
