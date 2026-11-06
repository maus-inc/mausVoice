import {
  convertFloat32ToPCM16,
  createGladiaStreamingSession,
  type GladiaStreamingSession,
  normalizeGladiaModel,
} from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  createAudioChunkPump,
  type AudioChunkPump,
} from "../utils/audio-chunking.utils";
import {
  buildGladiaCustomizations,
  createStreamingResampler,
  getGladiaSampleRate,
  type StreamingResampler,
} from "../utils/gladia.utils";
import { getLogger } from "../utils/log.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import {
  finalizeStreamingSession,
  sessionMissingResult,
} from "../utils/streaming-session.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { failedCaptureResult } from "./recording-transcription.utils";

const GLADIA_SAFE_LIVE_LIMIT_MS = 179 * 60 * 1000;
const STARTUP_BUFFER_SECONDS = 30;
const FINAL_READY_WAIT_MS = 10_000;
const MAX_SESSION_WARNINGS = 50;
const SESSION_WARNING_LIMIT_MESSAGE =
  "Additional Gladia audio-session warnings were omitted.";

export class GladiaTranscriptionSession implements TranscriptionSession {
  private readonly apiKey: string;
  private readonly model: string | null;
  private session: GladiaStreamingSession | null = null;
  private pump: AudioChunkPump | null = null;
  private resampler: StreamingResampler | null = null;
  private startupPromise: Promise<void> | null = null;
  private finalizationPromise: Promise<TranscriptionSessionResult> | null =
    null;
  private interimCallback: ((segment: string) => void) | null = null;
  private readonly warnings: string[] = [];
  private readonly warningSet = new Set<string>();
  private generation = 0;
  private finalized = false;
  private audioLost = false;
  private streamReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  constructor(apiKey: string, model: string | null) {
    this.apiKey = apiKey;
    this.model = model;
  }

  private addWarning(warning: string): void {
    if (this.warningSet.has(warning)) {
      return;
    }
    if (this.warnings.length >= MAX_SESSION_WARNINGS - 1) {
      if (!this.warningSet.has(SESSION_WARNING_LIMIT_MESSAGE)) {
        this.warnings.push(SESSION_WARNING_LIMIT_MESSAGE);
        this.warningSet.add(SESSION_WARNING_LIMIT_MESSAGE);
      }
      return;
    }
    this.warnings.push(warning);
    this.warningSet.add(warning);
  }

  supportsStreaming(): boolean {
    return true;
  }

  getMaximumRecordingDurationMs(): number {
    return GLADIA_SAFE_LIVE_LIMIT_MS;
  }

  setInterimResultCallback(callback: (segment: string) => void): void {
    this.interimCallback = callback;
  }

  async onRecordingStart(inputSampleRate: number): Promise<void> {
    // A replacement must retire the previous SDK and invalidate its callbacks.
    if (this.startupPromise) this.cleanup();
    this.finalizationPromise = null;
    const generation = ++this.generation;
    this.finalized = false;
    this.audioLost = false;
    this.warnings.length = 0;
    this.warningSet.clear();
    this.streamReady = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    const outputSampleRate = getGladiaSampleRate(inputSampleRate);
    this.resampler = createStreamingResampler(
      inputSampleRate,
      outputSampleRate,
    );
    this.pump = createAudioChunkPump({
      sampleRate: outputSampleRate,
      minChunkDurationMs: 20,
      maxChunkDurationMs: 100,
      maxBufferedSamples: outputSampleRate * STARTUP_BUFFER_SECONDS,
      canSend: () => this.session !== null && this.streamReady,
      // Once finalizing there is no later flush, so audio that fails to send
      // has nowhere to go and must not be re-queued.
      isFinalizing: () => this.finalized,
      sendChunk: (chunk) => {
        if (chunk.length > 0) {
          this.session?.sendAudio(convertFloat32ToPCM16(chunk));
        }
      },
      onError: () => {
        // A non-final send is restored by the pump and can be retried. A final
        // send cannot be retried, so the provider's transcript is incomplete.
        if (this.finalized) this.audioLost = true;
        this.addWarning("Gladia audio streaming failed.");
      },
    });

    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const language = await loadMyEffectiveDictationLanguage(state);
        if (generation !== this.generation) {
          return;
        }

        const customizations = buildGladiaCustomizations(
          collectDictionaryEntries(state),
        );
        this.session = createGladiaStreamingSession({
          apiKey: this.apiKey,
          sampleRate: outputSampleRate,
          language,
          model: this.model,
          customizations,
          onReady: () => {
            if (generation === this.generation) {
              this.streamReady = true;
              this.readyResolve?.();
              this.readyResolve = null;
              if (!this.audioLost) this.pump?.flushPendingSamples();
            }
          },
          onConnectionInterrupted: () => {
            if (generation === this.generation) {
              this.streamReady = false;
            }
          },
          onFinalSegment: (segment) => {
            if (generation === this.generation && !this.audioLost) {
              this.interimCallback?.(segment);
            }
          },
        });
        this.pump?.flushPendingSamples();
      } catch {
        if (generation !== this.generation) return;
        getLogger().error("Gladia streaming session could not start");
        this.addWarning("Gladia streaming session could not start.");
      }
    })();
    await this.startupPromise;
  }

  writeAudioChunk(input: Float32Array): void {
    if (this.finalized || this.audioLost || !this.resampler) return;
    try {
      const output = this.resampler?.process(input) ?? input;
      if (output.length > 0) {
        this.pump?.pushSamples(output);
        this.pump?.flushPendingSamples();
      }
    } catch {
      this.audioLost = true;
      this.addWarning("Gladia audio buffering failed.");
    }
  }

  private cancelledResult(): TranscriptionSessionResult {
    const missing = sessionMissingResult("Gladia");
    return {
      ...missing,
      metadata: {
        ...missing.metadata,
        modelSize: normalizeGladiaModel(this.model),
      },
      warnings: ["Gladia finalization was cancelled."],
    };
  }

  private incompleteAudioResult(): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata: {
        inferenceDevice: "API • Gladia (Streaming)",
        modelSize: normalizeGladiaModel(this.model),
        transcriptionMode: "api",
      },
      warnings: Array.from(
        new Set([
          ...this.warnings,
          "Gladia did not receive the complete recording.",
        ]),
      ),
    };
  }

  /** Wait for the stream only while this recording still owns it. */
  private async waitForFinalReady(generation: number): Promise<boolean> {
    if (this.streamReady || !this.readyPromise)
      return generation === this.generation;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const becameReady = await Promise.race([
      this.readyPromise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), FINAL_READY_WAIT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (generation !== this.generation) return false;
    if (!becameReady) {
      this.addWarning(
        "Gladia did not become ready before finalization; handing bounded audio to the SDK startup queue.",
      );
    }
    // The SDK buffers audio while starting or reconnecting. Hand the local
    // queue off once even if readiness timed out or was followed by interruption.
    this.streamReady = true;
    return true;
  }

  private flushFinalAudio(): void {
    const finalResampled = this.resampler?.flush();
    if (finalResampled && finalResampled.length > 0) {
      try {
        this.pump?.pushSamples(finalResampled);
      } catch {
        this.audioLost = true;
        this.addWarning("Gladia final audio buffering failed.");
      }
    }
    this.pump?.flushPendingSamples(true, true);
  }

  finalize(audio: StopRecordingResponse): Promise<TranscriptionSessionResult> {
    if (!this.finalizationPromise) {
      if (audio.captureFailed) {
        this.cleanup();
        this.finalizationPromise = Promise.resolve(failedCaptureResult());
      } else {
        this.finalizationPromise = this.finalizeOwned(audio);
      }
    }
    return this.finalizationPromise;
  }

  private async finalizeOwned(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const generation = this.generation;
    await this.startupPromise;
    if (generation !== this.generation) return this.cancelledResult();
    this.finalized = true;

    const activeSession = this.session;
    if (!activeSession) {
      const missing = sessionMissingResult("Gladia");
      const result = {
        ...missing,
        metadata: {
          ...missing.metadata,
          modelSize: normalizeGladiaModel(this.model),
        },
        warnings: Array.from(new Set([...this.warnings, ...missing.warnings])),
      };
      this.cleanup();
      return result;
    }
    try {
      if (this.audioLost) return this.incompleteAudioResult();
      if (!(await this.waitForFinalReady(generation)))
        return this.cancelledResult();
      this.flushFinalAudio();
      if (this.audioLost) return this.incompleteAudioResult();
      const result = await finalizeStreamingSession({
        session: activeSession,
        providerLabel: "Gladia",
        // The Voice AI adapter normalizes the wire request, so History must
        // identify the actual model rather than a stale persisted value.
        modelSize: normalizeGladiaModel(this.model),
        log: console.log,
        getWarnings: () => [...this.warnings, ...activeSession.getWarnings()],
      });
      if (generation !== this.generation) return this.cancelledResult();
      if (!activeSession.isComplete()) {
        return {
          ...result,
          rawTranscript: null,
          warnings: Array.from(
            new Set([
              ...result.warnings,
              "Gladia did not complete the recording transcription.",
            ]),
          ),
        };
      }
      return result;
    } finally {
      if (generation === this.generation && this.session === activeSession)
        this.cleanup();
    }
  }

  cleanup(): void {
    this.generation++;
    this.startupPromise = null;
    this.finalized = true;
    const session = this.session;
    const pump = this.pump;
    const resampler = this.resampler;
    const readyResolve = this.readyResolve;
    this.session = null;
    this.readyResolve = null;
    this.readyPromise = null;
    this.streamReady = false;
    this.pump = null;
    this.resampler = null;
    // Release each resource independently; a broken SDK close must not leave
    // pending readiness or buffered microphone audio owned by a dead session.
    for (const release of [
      () => readyResolve?.(),
      () => session?.cleanup(),
      () => pump?.resetBuffers(),
      () => resampler?.reset(),
    ]) {
      try {
        release();
      } catch {
        getLogger().error("Gladia session cleanup failed");
      }
    }
  }
}
