import { getLogger } from "../utils/log.utils";
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

export abstract class BaseApiTranscriptionSession implements TranscriptionSession {
  protected readonly providerLabel: string;
  protected readonly inferenceDevice: string;
  protected interimCallback: InterimResultCallback | null = null;
  protected streamSession: BaseApiStreamSession | null = null;

  constructor(options: BaseApiTranscriptionSessionOptions) {
    this.providerLabel = options.providerLabel;
    this.inferenceDevice = options.inferenceDevice;
  }

  abstract onRecordingStart(sampleRate: number): Promise<void>;
  abstract supportsStreaming(): boolean;

  cleanup(): void {
    if (this.streamSession) {
      this.streamSession.cleanup();
      this.streamSession = null;
    }
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.interimCallback = callback;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (!this.streamSession) {
      return this.notEstablishedResult();
    }
    return this.runFinalize(this.streamSession);
  }

  private notEstablishedResult(): TranscriptionSessionResult {
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
      getLogger().error(
        `[${this.providerLabel}] Failed to finalize session:`,
        error,
      );
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: this.inferenceDevice,
          transcriptionMode: "api",
        },
        warnings: [
          `${this.providerLabel} finalization failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        ],
      };
    }
  }
}
