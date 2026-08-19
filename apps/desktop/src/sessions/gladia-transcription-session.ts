import {
  convertFloat32ToPCM16,
  createGladiaStreamingSession,
  type GladiaStreamingSession,
} from "@maus-inc/voice-ai";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  private unlisten: UnlistenFn | null = null;
  private startupPromise: Promise<void> | null = null;
  private interimCallback: ((segment: string) => void) | null = null;
  private readonly warnings: string[] = [];
  private readonly warningSet = new Set<string>();
  private generation = 0;
  private finalized = false;
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
    const generation = ++this.generation;
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
      sendChunk: (chunk) => {
        if (chunk.length > 0) {
          this.session?.sendAudio(convertFloat32ToPCM16(chunk));
        }
      },
      onError: (error) => {
        this.addWarning(
          `Gladia audio streaming failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });

    const unlisten = await listen<{ samples: number[] }>(
      "audio_chunk",
      (event) => {
        if (generation !== this.generation || this.finalized) {
          return;
        }
        try {
          const input =
            event.payload.samples instanceof Float32Array
              ? event.payload.samples
              : Float32Array.from(event.payload.samples);
          const output = this.resampler?.process(input) ?? input;
          if (output.length > 0) {
            this.pump?.pushSamples(output);
            this.pump?.flushPendingSamples();
          }
        } catch (error) {
          this.addWarning(
            `Gladia audio buffering failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    );
    if (generation !== this.generation || this.finalized) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;

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
              this.pump?.flushPendingSamples();
            }
          },
          onConnectionInterrupted: () => {
            if (generation === this.generation) {
              this.streamReady = false;
            }
          },
          onFinalSegment: (segment) => {
            if (generation === this.generation) {
              this.interimCallback?.(segment);
            }
          },
        });
        this.pump?.flushPendingSamples();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        getLogger().error("Gladia streaming session could not start", error);
        this.addWarning(`Gladia streaming session could not start: ${message}`);
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    await this.startupPromise;
    this.finalized = true;

    const activeSession = this.session;
    if (!activeSession) {
      const missing = sessionMissingResult("Gladia");
      return {
        ...missing,
        metadata: { ...missing.metadata, modelSize: "solaria-1" },
        warnings: Array.from(new Set([...this.warnings, ...missing.warnings])),
      };
    }

    if (!this.streamReady && this.readyPromise) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const becameReady = await Promise.race([
        this.readyPromise.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), FINAL_READY_WAIT_MS);
        }),
      ]);
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!becameReady) {
        this.addWarning(
          "Gladia did not become ready before finalization; handing bounded audio to the SDK startup queue.",
        );
      }
      // The SDK buffers audio while starting or reconnecting. Once the bounded
      // readiness wait completes, allow the local queue to hand off exactly
      // once even when the prior ready promise resolved before an interruption.
      this.streamReady = true;
    }

    const finalResampled = this.resampler?.flush();
    if (finalResampled && finalResampled.length > 0) {
      try {
        this.pump?.pushSamples(finalResampled);
      } catch (error) {
        this.addWarning(
          `Gladia final audio buffering failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.pump?.flushPendingSamples(true);

    try {
      return await finalizeStreamingSession({
        session: activeSession,
        providerLabel: "Gladia",
        modelSize: "solaria-1",
        log: console.log,
        getWarnings: () => [...this.warnings, ...activeSession.getWarnings()],
      });
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    this.generation++;
    this.finalized = true;
    this.unlisten?.();
    this.unlisten = null;
    this.session?.cleanup();
    this.session = null;
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyPromise = null;
    this.streamReady = false;
    this.pump?.resetBuffers();
    this.pump = null;
    this.resampler?.reset();
    this.resampler = null;
  }
}
