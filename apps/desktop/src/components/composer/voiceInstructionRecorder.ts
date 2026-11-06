import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import { BrowserRecordingLease } from "../../utils/browser-recording-lease";

export type VoiceRecorderState = "idle" | "provider" | "browser";

// Native ownership and reset errors do not mean that browser recognition is
// safe: another recorder may still own the microphone, or a wipe is underway.
const RECORDING_OWNERSHIP_FAILURES = new Set([
  "A recording is already in progress",
  "Recording reset is in progress",
  "Recording admission is missing",
  "Recording admission was cancelled",
  "Recording admission was cancelled or already used",
  "Recording start was cancelled",
  "Recording window is closed",
]);

/** Read a failure message without assuming the thrown value is an Error. */
const failureMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
};

function isRecordingOwnershipFailure(error: unknown): boolean {
  try {
    const message = failureMessage(error);
    return RECORDING_OWNERSHIP_FAILURES.has(message);
  } catch {
    return true;
  }
}

export type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export type VoiceInstructionRecorderDeps = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transcribe: (audio: {
    samples: StopRecordingResponse["samples"];
    sampleRate: number;
  }) => Promise<string>;
  getPreferredMicrophone: () => string | null;
  createSpeechRecognition: () => SpeechRecognitionLike | null;
  getLang: () => string;
  canUseProvider: () => boolean;
  speechRecognitionSupported: boolean;
  unsupportedMessage: () => string;
  recordingUnavailableMessage: () => string;
  captureFailedMessage: () => string;
  onListeningChange: (listening: boolean) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onResetLevels: () => void;
  logger: { warning: (message: string) => void };
};

/**
 * Owns the Voice Edit recording lifecycle as an explicit state machine so that
 * the provider-recording, provider-transcription, browser-recording, and idle
 * states can never get out of sync with the UI's listening flag.
 *
 * Concurrency: a single `toggle` transition (start or stop) runs at a time via
 * `busy`. Every async operation carries an `opGen` token; `dispose` advances
 * the token so any in-flight start/stop/transcription completes as a no-op
 * instead of firing callbacks on an unmounted component. A `stopInFlight` flag
 * guarantees `stop_recording` is issued at most once per recording.
 */
export class VoiceInstructionRecorder {
  private state: VoiceRecorderState = "idle";
  private recognition: SpeechRecognitionLike | null = null;
  private busy = false;
  private disposed = false;
  private opGen = 0;
  private stopInFlight = false;
  private nativeLease: NativeRecordingLease | null = null;
  private browserLease: BrowserRecordingLease | null = null;

  constructor(private readonly deps: VoiceInstructionRecorderDeps) {}

  getState(): VoiceRecorderState {
    return this.state;
  }

  async toggle(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const gen = ++this.opGen;
    try {
      if (this.state === "idle") {
        await this.start(gen);
      } else {
        await this.stop(gen);
      }
    } finally {
      if (gen === this.opGen && !this.disposed) {
        this.busy = false;
      }
    }
  }

  private async startProvider(
    gen: number,
  ): Promise<"started" | "fallback" | "failed"> {
    const lease = new NativeRecordingLease(this.deps.invoke);
    this.nativeLease = lease;
    try {
      await lease.start(this.deps.getPreferredMicrophone() ?? null);
    } catch (error) {
      return this.handleProviderStartFailure(lease, gen, error);
    }
    // The native recorder is now genuinely open. If `dispose` (or another
    // toggle) ran while we awaited mic init, release the recorder instead
    // of notifying the UI it is listening — otherwise the OS recording
    // indicator stays on behind a closed composer.
    if (gen !== this.opGen || this.disposed) {
      if (this.nativeLease === lease) this.nativeLease = null;
      void lease.cancel().catch(() => undefined);
      return "failed";
    }
    this.state = "provider";
    // Do not mistake a failed UI callback for a failed native start: fallback
    // would otherwise open another microphone path while leaving this one live.
    this.deps.onListeningChange(true);
    return "started";
  }

  private async handleProviderStartFailure(
    lease: NativeRecordingLease,
    gen: number,
    error: unknown,
  ): Promise<"failed" | "fallback"> {
    if (this.nativeLease === lease) this.nativeLease = null;
    if (gen !== this.opGen || this.disposed) return "failed";
    if (!(await this.releaseBeforeFallback(lease, gen))) return "failed";
    if (isRecordingOwnershipFailure(error)) {
      this.deps.onError(this.deps.recordingUnavailableMessage());
      return "failed";
    }
    this.deps.logger.warning(
      "Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition",
    );
    return "fallback";
  }

  private async releaseBeforeFallback(
    lease: NativeRecordingLease | null,
    gen: number,
  ): Promise<boolean> {
    try {
      await lease?.ensureReleasedAfterFailure();
      return gen === this.opGen && !this.disposed;
    } catch {
      if (gen === this.opGen && !this.disposed) {
        this.deps.logger.warning(
          "Voice Edit Mode: unable to release provider recording",
        );
        this.deps.onError(this.deps.unsupportedMessage());
      }
      return false;
    }
  }

  private async start(gen: number): Promise<void> {
    if (
      this.deps.canUseProvider() &&
      (await this.startProvider(gen)) !== "fallback"
    )
      return;

    if (gen !== this.opGen || this.disposed) {
      return;
    }

    if (this.deps.speechRecognitionSupported) {
      await this.startBrowser(gen);
      return;
    }

    this.deps.onError(this.deps.unsupportedMessage());
  }

  private async startBrowser(gen: number): Promise<void> {
    if (this.browserLease) {
      this.deps.onError(this.deps.recordingUnavailableMessage());
      return;
    }
    const lease = new BrowserRecordingLease(this.deps.invoke);
    this.browserLease = lease;
    try {
      await lease.acquire();
    } catch {
      if (this.browserLease === lease) this.browserLease = null;
      if (gen === this.opGen && !this.disposed)
        this.deps.onError(this.deps.recordingUnavailableMessage());
      return;
    }
    if (gen !== this.opGen || this.disposed) {
      if (this.browserLease === lease) this.browserLease = null;
      void lease.release().catch(() => undefined);
      return;
    }
    this.dispatchBrowserStart(gen, lease);
  }

  private isCurrentBrowserLease(
    gen: number,
    lease: BrowserRecordingLease,
  ): boolean {
    return gen === this.opGen && !this.disposed && this.browserLease === lease;
  }

  private releaseBrowserLease(lease: BrowserRecordingLease): void {
    if (this.browserLease === lease) this.browserLease = null;
    void lease.release().catch(() => undefined);
  }

  private dispatchBrowserStart(
    gen: number,
    lease: BrowserRecordingLease,
  ): void {
    let recognition: SpeechRecognitionLike | null = null;
    let startDispatched = false;
    try {
      recognition = this.deps.createSpeechRecognition();
      // Dependency callbacks may synchronously dispose the recorder. Never
      // dispatch start after disposal has already released the reservation.
      if (!this.isCurrentBrowserLease(gen, lease)) {
        this.releaseBrowserLease(lease);
        return;
      }
      if (!recognition) {
        this.releaseBrowserLease(lease);
        this.deps.onError(this.deps.unsupportedMessage());
        return;
      }
      this.recognition = recognition;
      recognition.lang = this.deps.getLang();
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      const current = recognition;
      const canShowListening = this.attachBrowserRecognition(current, lease);
      if (
        !this.isCurrentBrowserLease(gen, lease) ||
        this.recognition !== current
      ) {
        if (this.recognition === current) this.detachBrowserRecognition();
        this.releaseBrowserLease(lease);
        return;
      }
      startDispatched = true;
      recognition.start();
      if (canShowListening()) {
        this.state = "browser";
        this.deps.onListeningChange(true);
      }
    } catch {
      this.handleBrowserStartFailure(gen, lease, recognition, startDispatched);
    }
  }

  private handleBrowserStartFailure(
    gen: number,
    lease: BrowserRecordingLease,
    recognition: SpeechRecognitionLike | null,
    startDispatched: boolean,
  ): void {
    if (recognition && startDispatched) {
      recognition.onresult = null;
      recognition.onerror = null;
      this.stopBrowserRecognition(recognition);
    } else {
      this.detachBrowserRecognition();
      this.releaseBrowserLease(lease);
    }
    if (gen === this.opGen && !this.disposed) {
      this.setIdle();
      this.deps.logger.warning(
        "Voice Edit Mode: browser speech recognition failed to start",
      );
      this.deps.onError(this.deps.unsupportedMessage());
    }
  }

  private attachBrowserRecognition(
    current: SpeechRecognitionLike,
    lease: BrowserRecordingLease,
  ): () => boolean {
    let recognitionFailed = false;
    const alive = () => this.recognition === current && !this.disposed;
    current.onresult = (event) => {
      if (!alive()) return;
      const first = event.results[0]?.[0]?.transcript;
      if (first) this.deps.onTranscript(`${first}`.trim());
    };
    current.onend = () => {
      if (this.browserLease === lease) this.browserLease = null;
      void lease.release().catch(() => undefined);
      if (this.recognition !== current) return;
      this.detachBrowserRecognition();
      if (!this.disposed) this.setIdle();
    };
    current.onerror = () => {
      if (!alive()) return;
      recognitionFailed = true;
      current.onresult = null;
      current.onerror = null;
      this.setIdle();
      this.deps.onError(this.deps.unsupportedMessage());
    };
    return () => alive() && !recognitionFailed;
  }

  private detachBrowserRecognition(): SpeechRecognitionLike | null {
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    }
    return recognition;
  }

  private stopBrowserRecognition(recognition: SpeechRecognitionLike): boolean {
    try {
      recognition.stop();
      return true;
    } catch {
      this.deps.logger.warning(
        "Voice Edit Mode: browser speech recognition failed to stop",
      );
      try {
        recognition.abort?.();
      } catch {
        this.deps.logger.warning(
          "Voice Edit Mode: browser speech recognition cleanup failed",
        );
      }
      return false;
    }
  }

  private async stop(gen: number): Promise<void> {
    if (this.state === "browser") {
      const stopped =
        !this.recognition || this.stopBrowserRecognition(this.recognition);
      if (gen === this.opGen && !this.disposed) {
        // A graceful stop may deliver a final result before its end event.
        if (!stopped && this.recognition) {
          this.recognition.onresult = null;
          this.recognition.onerror = null;
        }
        this.setIdle();
        if (!stopped) this.deps.onError(this.deps.unsupportedMessage());
      }
      return;
    }

    if (this.state === "provider") {
      await this.stopProviderRecording(gen);
    }
  }

  /**
   * Stop native provider recording, deliver its transcript, then reset levels.
   * If transcription fell back to the browser recognizer, that recognizer owns
   * the listening state, so we only return to idle on the genuine paths.
   */
  private async stopProviderRecording(gen: number): Promise<void> {
    if (this.stopInFlight) return;
    this.stopInFlight = true;
    let transcript: string | null = null;
    try {
      transcript = await this.transcribeProviderRecording(gen);
    } finally {
      try {
        this.finishProviderRecording(gen, transcript);
      } finally {
        this.stopInFlight = false;
      }
    }
  }

  private finishProviderRecording(
    gen: number,
    transcript: string | null,
  ): void {
    if (gen !== this.opGen || this.disposed) return;
    try {
      if (transcript) this.deps.onTranscript(transcript);
    } finally {
      // UI callbacks must not leave an already stopped recorder marked active.
      if (gen === this.opGen && !this.disposed) {
        try {
          this.deps.onResetLevels();
        } finally {
          if (this.state !== "browser") this.setIdle();
        }
      }
    }
  }

  private async transcribeProviderRecording(
    gen: number,
  ): Promise<string | null> {
    let response: StopRecordingResponse;
    try {
      const lease = this.nativeLease;
      if (!lease) throw new Error("Missing recording lease");
      response = await lease.stop();
      if (this.nativeLease === lease) this.nativeLease = null;
    } catch {
      return this.handleProviderTranscriptionFailure(gen);
    }
    if (gen !== this.opGen || this.disposed) return null;
    if (response.captureFailed) {
      this.deps.onError(this.deps.captureFailedMessage());
      return null;
    }
    try {
      return await this.transcribeProviderResponse(gen, response);
    } catch {
      return this.handleProviderTranscriptionFailure(gen);
    }
  }

  private async handleProviderTranscriptionFailure(gen: number): Promise<null> {
    if (gen !== this.opGen || this.disposed) return null;
    if (!(await this.releaseBeforeFallback(this.nativeLease, gen))) return null;
    this.nativeLease = null;
    this.deps.logger.warning("Voice Edit Mode: provider transcription failed");
    if (this.deps.speechRecognitionSupported) await this.startBrowser(gen);
    else this.deps.onError(this.deps.unsupportedMessage());
    return null;
  }

  private async transcribeProviderResponse(
    gen: number,
    response: StopRecordingResponse,
  ): Promise<string | null> {
    const samples = response.samples;
    const sampleRate = response.sampleRate ?? 0;
    if (!samples || samples.length === 0 || sampleRate <= 0) {
      return null;
    }
    const transcript = (
      await this.deps.transcribe({ samples, sampleRate })
    ).trim();
    if (gen !== this.opGen || this.disposed) return null;
    return transcript || null;
  }

  private setIdle(): void {
    const wasListening = this.state !== "idle";
    this.state = "idle";
    if (wasListening) this.deps.onListeningChange(false);
  }

  private disposeBrowserRecognition(): void {
    const recognition = this.recognition;
    if (!recognition && this.browserLease) {
      void this.browserLease.release().catch(() => undefined);
      this.browserLease = null;
    }
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      try {
        if (recognition.abort) recognition.abort();
        else this.stopBrowserRecognition(recognition);
      } catch {
        this.stopBrowserRecognition(recognition);
      }
    }
  }

  /**
   * Stop every active microphone path. Safe to call repeatedly. Any in-flight
   * operation is invalidated via `opGen`, so its deferred callbacks become
   * no-ops instead of firing after unmount.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opGen++;
    this.disposeBrowserRecognition();
    const lease = this.nativeLease;
    this.nativeLease = null;
    if (lease && !this.stopInFlight) {
      void lease.cancel().catch(() => undefined);
    }
    if (this.state !== "idle") {
      this.setIdle();
    }
  }
}
