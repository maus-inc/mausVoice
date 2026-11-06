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
  finishPretranscriber,
} from "./batch-transcription-session";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";
import {
  failedCaptureResult,
  usableRecordingAudio,
  wholeRecordingResult,
} from "./recording-transcription.utils";
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
  private startupChunkUnindexed = false;

  // Capture emits chunks as soon as the microphone opens and Tauri does not
  // replay events, so subscribe before recording starts and buffer until the
  // pretranscriber exists. Otherwise the opening words never reach it.
  private recordingOwnerId: string | undefined;
  private recordingGeneration: (() => number | null) | undefined;
  private generation = 0;
  private finalizing = false;
  private modelWarmup: Promise<{ error: unknown } | null> | null = null;

  async onBeforeRecordingStart(
    ownerId?: string,
    getGeneration?: () => number | null,
  ): Promise<void> {
    this.cleanup();
    this.abortScope = new SessionAbortScope();
    this.finalizing = false;
    this.recordingOwnerId = ownerId;
    this.recordingGeneration = getGeneration;
    const generation = this.generation;
    try {
      if (!(await this.startListening(generation))) return;
      if (generation !== this.generation || this.finalizing) return;
      this.modelWarmup = this.warmModel(
        getAppState().settings.aiTranscription,
        generation,
      ).then(
        () => null,
        (error: unknown) => ({ error }),
      );
    } catch {
      getLogger().warning(
        "[local-stream-session] early audio subscription failed",
      );
    }
  }

  /**
   * Resolve the prompt for this recording, or `null` when the session was
   * retired while the language lookup ran.
   */
  private async loadStartPrompt(
    state: ReturnType<typeof getAppState>,
    generation: number,
  ): Promise<string | null> {
    const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
    if (generation !== this.generation || this.finalizing) return null;
    return buildLocalizedTranscriptionPrompt({
      entries: collectDictionaryEntries(state),
      dictationLanguage,
      state,
    });
  }

  /**
   * Build the pretranscriber and replay the audio captured before it existed.
   * Anything that throws here leaves the recording live without spans, which
   * the caller turns into a whole-recording fallback.
   */
  private async beginPretranscription(
    sampleRate: number,
    state: ReturnType<typeof getAppState>,
    generation: number,
    hallucinationFilterEnabled: boolean,
  ): Promise<void> {
    if (
      !(await this.prepareStream(state.settings.aiTranscription, generation)) ||
      this.finalizing
    )
      return;

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
    if (this.startupChunkUnindexed) {
      throw new Error("startup audio had a chunk without a sample offset");
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
  }

  /** Record why this recording has no spans and release only stream resources. */
  private reportStartFailure(error: unknown, generation: number): void {
    if (generation !== this.generation || this.finalizing) return;
    const reason =
      error instanceof Error &&
      (error.message ===
        "startup audio outgrew the buffer before the pretranscriber was ready" ||
        error.message === "startup audio had a chunk without a sample offset")
        ? ` (${error.message})`
        : "";
    this.startupWarnings.push(
      `Local pretranscription unavailable, transcribing the whole recording${reason}`,
    );
    getLogger().warning(
      `[local-session] start failed, transcribing the whole recording${reason}`,
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

  async onRecordingStart(sampleRate: number): Promise<void> {
    if (this.finalizing) return;
    // Re-arm the abort scope for this recording without releasing the early
    // audio listener: `resetForRecording` calls `cleanup`, which would drop the
    // subscription and the startup buffer holding the words captured so far.
    this.abortScope.abort();
    this.abortScope = new SessionAbortScope();
    this.startupWarnings = [];
    const generation = this.generation;
    const state = getAppState();

    try {
      const prompt = await this.loadStartPrompt(state, generation);
      if (prompt === null) return;
      // Snapshot before anything below can fail, so the whole-recording
      // fallback records the same filter choice and prompt the spans would
      // have used rather than a preference the user may have changed since.
      const hallucinationFilterEnabled =
        state.userPrefs?.hallucinationFilterEnabled !== false;
      this.context = { prompt, hallucinationFilterEnabled };
      await this.beginPretranscription(
        sampleRate,
        state,
        generation,
        hallucinationFilterEnabled,
      );
    } catch (error) {
      this.reportStartFailure(error, generation);
    }
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    // Once finalization owns the recording, a late model or language lookup
    // must not start another pretranscriber or abort the whole-audio request.
    this.finalizing = true;
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
    const scope = this.abortScope;
    const context = this.context;
    const generation = this.generation;

    try {
      if (scope.isAborted) return discarded();
      if (audio.captureFailed) return failedCaptureResult();
      const pretranscribed = await this.finishPretranscription(
        audio,
        warnings,
        pretranscriber,
        context,
      );
      if (scope.isAborted) return discarded();
      if (pretranscribed) return pretranscribed;
      // Cancelled mid-finalize: the session is already torn down.
      if (pretranscriber?.isDisposed) return discarded();
      return await this.transcribeWholeRecording(
        audio,
        warnings,
        discarded,
        scope,
        context,
      );
    } finally {
      if (generation === this.generation) this.cleanup();
    }
  }

  cleanup(): void {
    this.generation += 1;
    this.modelWarmup = null;
    this.recordingOwnerId = undefined;
    this.recordingGeneration = undefined;
    this.abortScope.abort();
    getLogger().info(
      `[local-session] cleanup (hasUnlisten=${Boolean(this.unlisten)}, hasPretranscriber=${Boolean(this.pretranscriber)})`,
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
    this.startupChunkUnindexed = false;
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
    pretranscriber: PauseChunkedPretranscriber | null,
    context: LocalSessionContext | null,
  ): Promise<TranscriptionSessionResult | null> {
    const result = await finishPretranscriber(
      pretranscriber,
      audio,
      "local-session",
      "[local-session] pretranscription unusable, transcribing the whole recording",
    );
    if (!result) return null;
    return {
      rawTranscript: result.text.trim() || null,
      metadata: {
        ...result.metadata,
        transcriptionMode: "local",
        transcriptionPrompt: context?.prompt ?? null,
      },
      warnings: [...warnings, ...result.warnings],
    };
  }

  private async startListening(generation: number): Promise<boolean> {
    const unlisten = await listenToAudioChunks(
      (samples, offset) => {
        if (generation === this.generation)
          this.handleAudioChunk(samples, offset);
      },
      this.recordingOwnerId,
      this.recordingGeneration,
    );
    if (generation !== this.generation || this.finalizing) {
      unlisten();
      return false;
    }
    this.unlisten = unlisten;
    return true;
  }

  /**
   * The single `audio_chunk` registration for this session. Chunks go to the
   * pretranscriber once it exists, and into the startup buffer before that, so
   * the words captured while the sidecar was still loading are not lost.
   */
  private handleAudioChunk(samples: number[], offset: number | null): void {
    if (this.finalizing || !samples.length) return;
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
      if (this.pretranscriber) this.pretranscriber.push(samples, null);
      else this.startupChunkUnindexed = true;
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
    scope: SessionAbortScope,
    context: LocalSessionContext | null,
  ): Promise<TranscriptionSessionResult> {
    const recording = usableRecordingAudio(audio);
    if (!recording) {
      getLogger().warning(
        `[local-session] skipping transcription (rate=${audio.sampleRate}, samples=${audio.samples?.length ?? 0})`,
      );
      return {
        rawTranscript: null,
        metadata: {
          transcriptionMode: "local",
          transcriptionPrompt: context?.prompt ?? null,
        },
        warnings,
      };
    }

    const { samples: payloadSamples, sampleRate: rate } = recording;

    getLogger().info(
      `[local-session] transcribing the whole recording (${payloadSamples.length} samples at ${rate}Hz)`,
    );
    try {
      const result = await transcribeAudio({
        samples: payloadSamples,
        sampleRate: rate,
        hallucinationFilterEnabled: context?.hallucinationFilterEnabled,
        signal: scope.signal,
      });
      if (scope.isAborted) return discarded();
      return wholeRecordingResult(
        result,
        warnings,
        `[local-session] transcription complete (${result.rawTranscript.length} chars)`,
      );
    } catch (error) {
      // A discard aborts the request on purpose, so it returns nothing rather
      // than surfacing an error the user did not cause.
      if (scope.isAborted) {
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
  private async prepareStream(
    settings: SettingsTranscriptionState,
    generation: number,
  ): Promise<boolean> {
    if (!(await this.prepareModel(settings, generation)) || this.finalizing)
      return false;
    return this.unlisten !== null || this.startListening(generation);
  }

  private async prepareModel(
    settings: SettingsTranscriptionState,
    generation: number,
  ): Promise<boolean> {
    const warmup = this.modelWarmup;
    if (warmup) {
      const failure = await warmup;
      if (generation !== this.generation) return false;
      if (failure) throw failure.error;
    } else {
      await this.warmModel(settings, generation);
    }
    return generation === this.generation;
  }

  private async warmModel(
    settings: SettingsTranscriptionState,
    generation: number,
  ): Promise<void> {
    const manager = getLocalTranscriptionSidecarManager();
    const model = normalizeLocalWhisperModel(settings.modelSize);
    const preferGpu = isGpuPreferredTranscriptionDevice(settings.device);
    const status = await manager.getModelStatus({ model, preferGpu });
    if (generation !== this.generation || this.finalizing) return;
    if (!status.downloaded || !status.valid) {
      await manager.downloadModel({ model, preferGpu });
    }
  }
}
