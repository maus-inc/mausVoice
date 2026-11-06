import { getLogger } from "../utils/log.utils";
import {
  AUDIO_CHECKSUM_SEED,
  checksumFloatSamples,
  checksumRecordingSamples,
} from "../utils/audio-samples.utils";
import type {
  InterimResultCallback,
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";

// Native events can arrive after the stop IPC response. Startup may also still
// be opening a provider connection when a very short recording is stopped.
const TAIL_EVENT_WAIT_MS = 2_000;
const STARTUP_WAIT_MS = 25_000;
const MISSING_AUDIO_WARNING =
  "Live transcription did not receive the complete recording";

/**
 * Check native-to-webview offset coverage before accepting a live transcript.
 * A checksum detects sample corruption, but cannot prove equality or provider processing.
 * This wrapper deliberately does not retry with a potentially different provider
 * or try to rewrite interim text that may already have reached another app.
 */
/** The continuity check can only run on a real sample rate. */
const isUsableInputRate = (rate: number): boolean =>
  Number.isFinite(rate) && rate > 0;

/** A retired session delivers nothing, and must not look like a failure. */
const retiredResult = (): TranscriptionSessionResult => ({
  rawTranscript: null,
  metadata: {},
  warnings: [],
});

export class ContinuousLiveSession implements TranscriptionSession {
  private ready = false;
  private failed = false;
  private disposed = false;
  private sourceRetired = false;
  private sealed = false;
  private nextOffset = 0;
  private audioChecksum = AUDIO_CHECKSUM_SEED;
  private inputSampleRate: number | null = null;
  private expectedLength: number | null = null;
  private expectedSampleRate: number | null = null;
  private waitResolve: ((complete: boolean) => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private finalization: Promise<TranscriptionSessionResult> | null = null;
  private resolveCancellation: (() => void) | null = null;
  private readonly cancellation = new Promise<void>((resolve) => {
    this.resolveCancellation = resolve;
  });
  readonly getMaximumRecordingDurationMs?: () => number;

  constructor(private readonly source: TranscriptionSession) {
    const limit = source.getMaximumRecordingDurationMs;
    if (limit) this.getMaximumRecordingDurationMs = () => limit.call(source);
  }

  async onBeforeRecordingStart(
    ownerId?: string,
    getGeneration?: () => number | null,
  ): Promise<void> {
    if (!this.disposed)
      await this.source.onBeforeRecordingStart?.(ownerId, getGeneration);
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    if (this.disposed || this.failed) return;
    if (!isUsableInputRate(sampleRate)) {
      this.fail();
      return;
    }
    this.inputSampleRate = sampleRate;
    if (
      this.expectedSampleRate !== null &&
      this.expectedSampleRate !== sampleRate
    ) {
      this.fail();
      return;
    }
    try {
      await this.source.onRecordingStart(sampleRate);
    } catch (error) {
      this.fail();
      throw error;
    }
    if (this.disposed) return;
    this.ready = true;
    // Switch from the startup deadline to a shorter late-event deadline.
    if (this.waitResolve && this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(
        () => this.finishWait(false),
        TAIL_EVENT_WAIT_MS,
      );
    }
    this.checkWait();
  }

  supportsStreaming(): boolean {
    return this.source.supportsStreaming();
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.source.setInterimResultCallback((segment) => {
      if (!this.failed && !this.disposed) callback(segment);
    });
  }

  writeAudioChunk(chunk: Float32Array, offset: number): void {
    if (this.failed || this.disposed || this.sealed || chunk.length === 0)
      return;
    if (
      !Number.isSafeInteger(offset) ||
      offset !== this.nextOffset ||
      chunk.some((sample) => !Number.isFinite(sample))
    ) {
      this.fail();
      return;
    }
    try {
      if (!this.source.writeAudioChunk) throw new Error("Missing audio sink");
      const checksum = checksumFloatSamples(chunk, this.audioChecksum);
      this.source.writeAudioChunk(chunk, offset);
      this.audioChecksum = checksum;
      this.nextOffset += chunk.length;
    } catch {
      this.fail();
      return;
    }
    this.checkWait();
  }

  finalize(audio: StopRecordingResponse): Promise<TranscriptionSessionResult> {
    if (!this.finalization) this.finalization = this.finalizeOnce(audio);
    return this.finalization;
  }

  /**
   * Check the stop reply against this recording. A failed capture or a rate
   * that disagrees with the live stream means the tail cannot be trusted, so the
   * recording is failed rather than finalized with a partial transcript.
   */
  private acceptStopAudio(audio: StopRecordingResponse): void {
    const rate = audio.sampleRate;
    if (
      audio.captureFailed ||
      rate == null ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      (this.inputSampleRate !== null && rate !== this.inputSampleRate)
    ) {
      this.fail();
      return;
    }
    this.expectedSampleRate = rate;
  }

  /** True when every captured sample arrived, in order, and nothing changed. */
  private captureIsComplete(
    complete: boolean,
    audio: StopRecordingResponse,
  ): boolean {
    if (!complete || this.failed) return false;
    if (this.nextOffset !== this.expectedLength) return false;
    return checksumRecordingSamples(audio.samples) === this.audioChecksum;
  }

  private async finalizeOnce(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    this.expectedLength = audio.samples.length;
    this.acceptStopAudio(audio);
    const complete = await this.waitForContinuity();
    if (this.disposed) return retiredResult();
    if (!this.captureIsComplete(complete, audio)) {
      this.cleanup();
      return {
        rawTranscript: null,
        metadata: { transcriptionMode: "api" },
        warnings: [MISSING_AUDIO_WARNING],
      };
    }
    this.sealed = true;
    try {
      const result = await Promise.race([
        this.source.finalize(audio),
        this.cancellation.then(() => null),
      ]);
      if (this.disposed || result === null) return retiredResult();
      return result;
    } catch {
      if (this.disposed) return retiredResult();
      this.cleanup();
      return {
        rawTranscript: null,
        metadata: { transcriptionMode: "api" },
        warnings: ["Live transcription could not be finalized"],
      };
    }
  }

  private waitForContinuity(): Promise<boolean> {
    if (
      this.failed ||
      this.disposed ||
      this.nextOffset > this.expectedLength!
    ) {
      return Promise.resolve(false);
    }
    if (this.ready && this.nextOffset === this.expectedLength) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(
        () => this.finishWait(false),
        this.ready ? TAIL_EVENT_WAIT_MS : STARTUP_WAIT_MS,
      );
    });
  }

  private checkWait(): void {
    if (!this.waitResolve || this.expectedLength === null) return;
    if (this.failed || this.disposed || this.nextOffset > this.expectedLength) {
      this.finishWait(false);
    } else if (this.ready && this.nextOffset === this.expectedLength) {
      this.finishWait(true);
    }
  }

  private finishWait(complete: boolean): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const resolve = this.waitResolve;
    this.waitResolve = null;
    resolve?.(complete);
  }

  private fail(): void {
    this.failed = true;
    this.retireSource();
    this.checkWait();
  }

  private retireSource(): void {
    if (this.sourceRetired) return;
    this.sourceRetired = true;
    try {
      this.source.cleanup();
    } catch {
      getLogger().warning("Could not close the incomplete live stream");
    }
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveCancellation?.();
    this.resolveCancellation = null;
    this.finishWait(false);
    this.retireSource();
  }
}
