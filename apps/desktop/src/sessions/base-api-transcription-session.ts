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

export abstract class BaseApiTranscriptionSession implements TranscriptionSession {
  protected readonly providerLabel: string;
  protected readonly inferenceDevice: string;
  protected interimCallback: InterimResultCallback | null = null;

  constructor(options: BaseApiTranscriptionSessionOptions) {
    this.providerLabel = options.providerLabel;
    this.inferenceDevice = options.inferenceDevice;
  }

  abstract onRecordingStart(sampleRate: number): Promise<void>;
  abstract cleanup(): void;
  abstract supportsStreaming(): boolean;
  protected abstract runFinalize(): Promise<string | null>;

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.interimCallback = callback;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const failureResult = (message: string): TranscriptionSessionResult => ({
      rawTranscript: null,
      metadata: {
        inferenceDevice: this.inferenceDevice,
        transcriptionMode: "api",
      },
      warnings: [message],
    });

    try {
      getLogger().verbose(
        `[${this.providerLabel}] Finalizing streaming session...`,
      );
      const finalizeStart = performance.now();
      const transcript = await this.runFinalize();
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
      return failureResult(
        `${this.providerLabel} finalization failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
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
}
