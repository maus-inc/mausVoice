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
  createAudioChunkStartupBuffer,
  type AudioChunkStartupBuffer,
} from "../utils/audio-chunk-startup-buffer";
import {
  createActionPretranscriber,
  LOCAL_PRETRANSCRIPTION,
  logPretranscription,
} from "./batch-transcription-session";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";
import { SessionAbortScope } from "./session-abort-scope";

// Bounds the startup buffer's memory. The capture rate is unknown when the
// buffer starts, so the cap is in samples: 30 s at 48 kHz, longer at lower
// rates (90 s at 16 kHz). Past it the sidecar is far from ready, so buffering
// stops and finalize batch-transcribes the full recording instead.
const MAX_STARTUP_BUFFER_SECONDS = 30;
/** The rate the sample cap is budgeted at before the real rate is known. */
const ASSUMED_STARTUP_SAMPLE_RATE = 48_000;

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
 *
 * One instance serves one recording: `createTranscriptionSession` builds a
 * fresh session per dictation.
 */
export class LocalTranscriptionSession implements TranscriptionSession {
  private unlisten: UnlistenFn | null = null;
  private pretranscriber: PauseChunkedPretranscriber | null = null;
  private context: LocalSessionContext | null = null;
  /** Per recording, not per session instance: `onRecordingStart` re-arms it. */
  private abortScope = new SessionAbortScope();
  private startupWarnings: string[] = [];
  /**
   * Tauri does not replay `audio_chunk`, so anything captured between the
   * early subscribe and a usable pretranscriber is held here and replayed in
   * order with its absolute index.
   */
  private readonly startupBuffer: AudioChunkStartupBuffer =
    createAudioChunkStartupBuffer(
      (dropped) => {
        this.startupBufferOverflowed = true;
        getLogger().warning(
          `[local-session] startup audio buffer overflowed; dropped ${dropped} samples`,
        );
      },
      MAX_STARTUP_BUFFER_SECONDS,
      ASSUMED_STARTUP_SAMPLE_RATE,
    );
  private startupBufferOverflowed = false;

  // Capture emits chunks as soon as the microphone opens and Tauri does not
  // replay events, so subscribe before recording starts and buffer until the
  // pretranscriber exists. Otherwise the opening words never reach it.
  async onBeforeRecordingStart(): Promise<void> {
    this.cleanup();
    try {
      // Subscribe first, then prepare the model. The order is the whole point:
      // the caller is still holding the microphone shut at this point, so
      // anything awaited before the subscription is registered is time in which
      // the user can speak and nothing can be captured. Warming first meant a
      // first-run model download -- up to MODEL_DOWNLOAD_TIMEOUT_MS, 45 minutes
      // -- sat in front of `start_recording`, so the hotkey looked dead for the
      // whole of it and every word spoken was lost. Subscribing first is what
      // makes the comment true: the download now happens while chunks are
      // already landing in the startup buffer.
      await this.startListening();
      await this.warmModel(getAppState().settings.aiTranscription);
    } catch (error) {
      getLogger().warning(
        `[local-stream-session] early audio subscription failed (${this.toErrorMessage(error)})`,
      );
    }
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    // Re-arm the abort scope for this recording without releasing the early
    // audio listener: `resetForRecording` calls `cleanup`, which would drop the
    // subscription and the startup buffer holding the words captured so far.
    this.abortScope.abort();
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
      // Snapshot before anything below can fail, so the whole-recording
      // fallback records the same filter choice and prompt the spans would
      // have used rather than a preference the user may have changed since.
      this.context = {
        prompt,
        hallucinationFilterEnabled:
          state.userPrefs?.hallucinationFilterEnabled !== false,
      };
      const { hallucinationFilterEnabled } = this.context;

      // The early hook did not run or could not subscribe. Either way the
      // model has to be ready, and the warm is idempotent because it is
      // awaited once per recording here and at most once in the early hook.
      await this.warmModel(state.settings.aiTranscription);
      if (!this.unlisten) {
        await this.startListening();
      }

      const pretranscriber = createActionPretranscriber(sampleRate, {
        config: LOCAL_PRETRANSCRIPTION,
        hallucinationFilterEnabled,
        selectText: (result) => result.sanitizedTranscript,
      });
      this.pretranscriber = pretranscriber;
      // Tauri does not replay audio_chunk events, so anything captured before
      // the pretranscriber existed is held in the startup buffer. Once the
      // buffer has overflowed the opening words are already gone, so the
      // spans can no longer cover the recording and the whole-recording
      // request has to be used instead.
      if (this.startupBufferOverflowed) {
        throw new Error(
          "startup audio outgrew the buffer before the pretranscriber was ready",
        );
      }
      const buffered = this.startupBuffer.pendingSampleCount();
      if (buffered > 0) {
        getLogger().info(
          `[local-session] flushing ${buffered} samples captured during startup`,
        );
      }
      // Replays in order, each chunk with its absolute sample index, which is
      // what the pretranscriber needs to align the live stream with the final
      // recording.
      this.startupBuffer.setSink((chunk, offset) =>
        pretranscriber.push(chunk, offset),
      );
      this.startupBuffer.replay();
      this.startupBuffer.setSink(null);
      this.startupBufferOverflowed = false;
    } catch (error) {
      const message = this.toErrorMessage(error);
      this.startupWarnings.push(
        `Local pretranscription unavailable, transcribing the whole recording (${message})`,
      );
      getLogger().warning(
        `[local-session] start failed, transcribing the whole recording (${message})`,
      );
      // The recording is still live, it just has no pretranscriber. Release
      // only the stream resources: the abort scope has to stay live for the
      // whole-recording request at stop, and the start-time context has to
      // survive so the fallback records the same filter choice and prompt
      // rather than rereading a preference the user may have changed since.
      // The buffered startup audio is dropped, because there is no span path
      // left to replay it into.
      this.releaseStream();
    }
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const warnings = [...this.startupWarnings];
    // A user-initiated discard must not come back looking like a failure.
    // `handleEmptyTranscriptionResult` treats a null transcript *with* warnings
    // as a transcription failure: it shows "Transcription failed. Your recording
    // is saved so you can retry." and stores a junk history row for a dictation
    // the user threw away on purpose. `startupWarnings` is non-empty whenever
    // the model warm failed or the startup buffer overflowed, so a cancel
    // during finalize reproduced that for no reason the user caused.
    // `BatchTranscriptionSession` returns exactly this on its abort path.
    const discarded = (): TranscriptionSessionResult => ({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
    const pretranscriber = this.pretranscriber;

    try {
      const pretranscribed = await this.finishPretranscription(audio, warnings);
      if (pretranscribed) return pretranscribed;
      // Cancelled mid-finalize: the session is already torn down.
      if (pretranscriber?.isDisposed || this.abortScope.isAborted) {
        return discarded();
      }
      return await this.transcribeWholeRecording(audio, warnings, discarded);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    this.abortScope.abort();
    getLogger().info(
      `[local-session] cleanup (hasUnlisten=${!!this.unlisten}, hasPretranscriber=${!!this.pretranscriber})`,
    );
    this.releaseStream();
    this.context = null;
  }

  private releaseStream(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.pretranscriber?.dispose();
    this.pretranscriber = null;
    this.startupBuffer.reset();
    this.startupBufferOverflowed = false;
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

  private async startListening(): Promise<void> {
    this.unlisten = await listenToAudioChunks((samples, offset) =>
      this.handleAudioChunk(samples, offset),
    );
  }

  /**
   * The single `audio_chunk` registration for this session. Chunks go to the
   * pretranscriber once it exists, and into the startup buffer before that, so
   * the words captured while the sidecar was still loading are not lost.
   */
  private handleAudioChunk(samples: number[], offset: number | null): void {
    if (!samples.length) return;
    // A null offset is how the stream says it is no longer contiguous:
    // `PauseChunkedPretranscriber.push` disables pretranscription for the
    // recording, and `dictation-recording-intake` drops the chunk. Coercing it
    // to 0 anchored `streamStart` at the first sample on a guess, so a stream
    // whose opening chunk had no offset was aligned against the final recording
    // instead of being rejected. Same decision as the intake path, same wording.
    if (offset === null) {
      getLogger().warning(
        "[local-session] Dropped audio_chunk with no sample offset; the recording stream is no longer contiguous",
      );
      return;
    }
    if (this.pretranscriber) {
      this.pretranscriber.push(samples, offset);
      return;
    }
    this.startupBuffer.push(samples, offset);
  }

  private async transcribeWholeRecording(
    audio: StopRecordingResponse,
    warnings: string[],
    discarded: () => TranscriptionSessionResult,
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
        return discarded();
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
