import { getLogger } from "../utils/log.utils";
import { failedCaptureResult } from "./recording-transcription.utils";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
  InterimResultCallback,
} from "../types/transcription-session.types";

export type BaseApiTranscriptionSessionOptions = {
  providerLabel: string;
  inferenceDevice: string;
};

export type BaseApiStreamSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk?: (chunk: Float32Array) => void;
};

// Only fixed messages created by our streaming adapters may reach history.
// SDK and transport errors can contain credentials or dictated text.
const SAFE_STREAM_FAILURES = new Set([
  "Streaming transcript could not be read",
  "Streaming audio finalization was cancelled",
  "Streaming audio connection was lost",
  "Streaming audio could not be sent",
  "Streaming audio provider returned an error",
  "Streaming audio ended before finalization completed",
  "Streaming audio could not be finalized",
  "Streaming audio finalization timed out",
  "ElevenLabs audio queue limit reached",
  "ElevenLabs connection closed before finalization",
  "ElevenLabs audio processing failed",
  "ElevenLabs stream was cancelled",
  "Unable to send final audio or commit to ElevenLabs",
  "ElevenLabs finalization timed out",
  "ElevenLabs reported a streaming error",
  "ElevenLabs connection failed",
  "Azure streaming session is unavailable",
  "Azure streaming session was closed",
  "Azure streaming session was cancelled",
  "Azure streaming audio could not be sent",
  "Azure streaming audio could not be finalized",
  "Azure streaming finalization timed out",
  "Azure streaming recognition was interrupted",
  "Azure streaming recognition stopped unexpectedly",
  "Azure streaming recognition could not stop",
]);

export abstract class BaseApiTranscriptionSession implements TranscriptionSession {
  protected readonly providerLabel: string;
  protected readonly inferenceDevice: string;
  protected interimCallback: InterimResultCallback | null = null;
  protected streamSession: BaseApiStreamSession | null = null;
  private streamGeneration = 0;

  constructor(options: BaseApiTranscriptionSessionOptions) {
    this.providerLabel = options.providerLabel;
    this.inferenceDevice = options.inferenceDevice;
  }

  abstract onRecordingStart(sampleRate: number): Promise<void>;
  abstract supportsStreaming(): boolean;

  writeAudioChunk(chunk: Float32Array): void {
    this.streamSession?.writeAudioChunk?.(chunk);
  }

  cleanup(): void {
    this.streamGeneration += 1;
    const session = this.streamSession;
    this.streamSession = null;
    session?.cleanup();
  }

  /** Retire the previous recording before starting another provider stream. */
  protected beginStreamStartup(): number {
    this.cleanup();
    return this.streamGeneration;
  }

  protected ownsStreamStartup(generation: number): boolean {
    return generation === this.streamGeneration;
  }

  protected adoptStreamSession(
    generation: number,
    session: BaseApiStreamSession,
  ): boolean {
    if (!this.ownsStreamStartup(generation)) {
      session.cleanup();
      return false;
    }
    this.streamSession = session;
    return true;
  }

  protected interimForStartup(
    generation: number,
  ): InterimResultCallback | undefined {
    const callback = this.interimCallback;
    if (!callback) return undefined;
    return (segment) => {
      if (this.ownsStreamStartup(generation)) callback(segment);
    };
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.interimCallback = callback;
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (audio.captureFailed) {
      this.cleanup();
      return failedCaptureResult();
    }
    if (!this.streamSession) {
      return this.notEstablishedResult();
    }
    return this.runFinalize(this.streamSession);
  }

  protected notEstablishedResult(): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata: {
        inferenceDevice: this.inferenceDevice,
        transcriptionMode: "api",
      },
      warnings: [`${this.providerLabel} streaming session was not established`],
    };
  }

  private async runFinalize(
    streamSession: BaseApiStreamSession,
  ): Promise<TranscriptionSessionResult> {
    try {
      getLogger().verbose(
        `[${this.providerLabel}] Finalizing streaming session...`,
      );
      const finalizeStart = performance.now();
      const transcript = await streamSession.finalize();
      const durationMs = Math.round(performance.now() - finalizeStart);

      getLogger().verbose(`[${this.providerLabel}] Transcript timing:`, {
        durationMs,
      });
      getLogger().verbose(
        `[${this.providerLabel}] Received transcript, length:`,
        transcript?.length ?? 0,
      );

      return {
        rawTranscript: transcript || null,
        metadata: {
          inferenceDevice: this.inferenceDevice,
          transcriptionMode: "api",
          transcriptionDurationMs: durationMs,
        },
        warnings: [],
      };
    } catch (error) {
      const detail =
        error instanceof Error && SAFE_STREAM_FAILURES.has(error.message)
          ? error.message
          : null;
      getLogger().error(`[${this.providerLabel}] Failed to finalize session`);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: this.inferenceDevice,
          transcriptionMode: "api",
        },
        warnings: [
          detail
            ? `${this.providerLabel} finalization failed: ${detail}`
            : `${this.providerLabel} finalization failed`,
        ],
      };
    }
  }
}
