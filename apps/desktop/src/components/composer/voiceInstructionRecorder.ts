import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { BrowserRecordingLease } from "../../utils/browser-recording-lease";
import {
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import {
  beginNativeRecording,
  discardNativeRecording,
  stopNativeRecording,
} from "../../utils/native-recording-session";

export type VoiceRecorderState = "idle" | "provider" | "browser";

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
};

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
  /** Shown when the recorder could not be claimed for browser recognition. */
  recordingUnavailableMessage: () => string;
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
  private browserLease: BrowserRecordingLease | null = null;
  private busy = false;
  private disposed = false;
  private opGen = 0;
  private stopInFlight = false;
  private recognitionEnded: Promise<void> | null = null;
  private settleRecognitionEnd: (() => void) | null = null;
  private unsubscribeClear: (() => void) | null = null;

  constructor(private readonly deps: VoiceInstructionRecorderDeps) {
    this.unsubscribeClear = subscribeToLocalDataClearRequested(() => {
      this.abortForClear();
    });
  }

  getState(): VoiceRecorderState {
    return this.state;
  }

  async toggle(): Promise<void> {
    if (this.busy || this.disposed || isLocalDataClearRequested()) return;
    this.busy = true;
    const gen = ++this.opGen;
    try {
      if (this.state === "idle") {
        this.detachBrowserRecognition();
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
  ): Promise<"started" | "blocked" | "unavailable"> {
    try {
      await beginNativeRecording(
        this.deps.getPreferredMicrophone() ?? null,
        {},
        this.deps.invoke,
      );
      // The native recorder is now genuinely open. If `dispose` (or another
      // toggle) ran while we awaited mic init, release the recorder instead
      // of notifying the UI it is listening — otherwise the OS recording
      // indicator stays on behind a closed composer.
      if (gen !== this.opGen || this.disposed || isLocalDataClearRequested()) {
        void discardNativeRecording();
        return "blocked";
      }
      this.state = "provider";
      this.deps.onListeningChange(true);
      return "started";
    } catch (error) {
      if (gen !== this.opGen || this.disposed) return "blocked";
      if (
        isLocalDataClearRequested() ||
        extractErrorMessage(error).includes("Local data is being cleared")
      ) {
        return "blocked";
      }
      this.deps.logger.warning(
        "Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition",
      );
    }
    return "unavailable";
  }

  private async start(gen: number): Promise<void> {
    if (isLocalDataClearRequested()) return;
    if (this.deps.canUseProvider()) {
      const outcome = await this.startProvider(gen);
      if (outcome === "started" || outcome === "blocked") return;
    }

    if (gen !== this.opGen || this.disposed || isLocalDataClearRequested()) {
      return;
    }

    if (this.deps.speechRecognitionSupported) {
      await this.startBrowser(gen);
      return;
    }

    this.deps.onError(this.deps.unsupportedMessage());
  }

  /**
   * Start the webview's own recognizer under a native recording lease.
   *
   * Browser recognition opens the microphone inside the webview, which the
   * native coordinator cannot see. The lease claims the one native slot for as
   * long as the recognizer runs, so a dictation started meanwhile is refused
   * instead of opening a second capture beside it, and the slot is released
   * only once native has acknowledged the release.
   */
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
      void lease.release().catch(() => undefined);
      if (gen === this.opGen && !this.disposed) {
        this.deps.onError(this.deps.recordingUnavailableMessage());
      }
      return;
    }
    if (gen !== this.opGen || this.disposed) {
      this.releaseBrowserLease(lease);
      return;
    }
    this.dispatchBrowserStart(lease);
  }

  private releaseBrowserLease(lease: BrowserRecordingLease): void {
    if (this.browserLease === lease) this.browserLease = null;
    void lease.release().catch(() => undefined);
  }

  private dispatchBrowserStart(lease: BrowserRecordingLease): void {
    try {
      const recognition = this.deps.createSpeechRecognition();
      if (this.browserLease !== lease || this.disposed) {
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
      const alive = () => this.recognition === recognition && !this.disposed;
      let settleEnd: () => void = () => undefined;
      this.recognitionEnded = new Promise<void>((resolve) => {
        settleEnd = resolve;
      });
      this.settleRecognitionEnd = settleEnd;
      recognition.onresult = (event) => {
        if (!alive()) return;
        const first = event.results[0]?.[0]?.transcript;
        if (first) this.deps.onTranscript(`${first}`.trim());
      };
      recognition.onend = () => {
        settleEnd();
        // Browser capture has ended, so the slot goes back even when the
        // component has already moved on.
        this.releaseBrowserLease(lease);
        if (!alive()) return;
        this.setIdle();
      };
      recognition.onerror = () => {
        settleEnd();
        this.releaseBrowserLease(lease);
        if (!alive()) return;
        this.setIdle();
        this.deps.onError(this.deps.unsupportedMessage());
      };
      recognition.start();
      if (alive()) {
        this.state = "browser";
        this.deps.onListeningChange(true);
      }
    } catch {
      const recognition = this.detachBrowserRecognition();
      if (recognition) this.stopBrowserRecognition(recognition);
      this.setIdle();
      this.releaseBrowserLease(lease);
      this.deps.logger.warning(
        "Voice Edit Mode: browser speech recognition failed to start",
      );
      this.deps.onError(this.deps.unsupportedMessage());
    }
  }

  private detachBrowserRecognition(): SpeechRecognitionLike | null {
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    }
    // Callbacks are gone, so `onend` can no longer arrive; release any
    // `stop()` that is waiting for it instead of leaving it pending forever.
    this.settleRecognitionEnd?.();
    this.settleRecognitionEnd = null;
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
      const stopped = await this.stopBrowserCapture();
      if (gen === this.opGen && !this.disposed) {
        // stop() can deliver its final result asynchronously. Keep this
        // recognizer's callbacks until end, dispose, or the next recording.
        this.setIdle(stopped);
        if (!stopped) this.deps.onError(this.deps.unsupportedMessage());
      }
      return;
    }

    if (this.state === "provider") {
      await this.stopProviderRecording(gen);
    }
  }

  /**
   * Stop the webview recognizer and free the native slot, in that order.
   *
   * The lease is captured before the stop request so it stays claimed until
   * the recognizer reports `onend`: releasing on the request alone would free
   * the slot while browser capture is still winding down, letting another
   * recording start beside it. The final release is idempotent with `onend`'s
   * own call and is awaited so a start that follows this stop sees a free
   * slot only after native has acknowledged it.
   */
  private async stopBrowserCapture(): Promise<boolean> {
    const lease = this.browserLease;
    const recognition = this.recognition;
    const stopped = !recognition || this.stopBrowserRecognition(recognition);
    const ended = recognition && stopped ? this.recognitionEnded : null;
    if (ended) await ended.catch(() => undefined);
    if (lease) {
      if (this.browserLease === lease) this.browserLease = null;
      await lease.release().catch(() => undefined);
    }
    return stopped;
  }

  /**
   * Stop native provider recording, deliver its transcript, then reset levels.
   * If transcription fell back to the browser recognizer, that recognizer owns
   * the listening state, so we only return to idle on the genuine paths.
   */
  private async stopProviderRecording(gen: number): Promise<void> {
    const transcript = await this.transcribeProviderRecording(gen);
    if (gen !== this.opGen || this.disposed) return;
    if (transcript) {
      this.deps.onTranscript(transcript);
    }
    this.deps.onResetLevels();
    if (this.state !== "browser") {
      this.setIdle();
    }
  }

  private async transcribeProviderRecording(
    gen: number,
  ): Promise<string | null> {
    if (this.stopInFlight) return null;
    this.stopInFlight = true;
    try {
      try {
        const response = await stopNativeRecording(this.deps.invoke);
        if (gen !== this.opGen || this.disposed) return null;
        return await this.transcribeProviderResponse(gen, response);
      } catch {
        if (gen !== this.opGen || this.disposed) {
          // The stop failed while this operation was invalidated:
          // releaseCapture skipped its own discard because the stop was in
          // flight, so drop the restored native handle here or the
          // microphone stays live behind the invalidated continuation.
          void discardNativeRecording();
          return null;
        }
        this.deps.logger.warning(
          "Voice Edit Mode: provider transcription failed",
        );
        if (this.deps.speechRecognitionSupported) {
          await this.startBrowser(gen);
        } else {
          this.deps.onError(this.deps.unsupportedMessage());
        }
        // The failed stop restored the native handle, which is why the
        // fallback above is refused the slot: drop the dead capture here
        // or the microphone stays live behind an idle recorder.
        await discardNativeRecording();
        return null;
      }
    } finally {
      this.stopInFlight = false;
    }
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

  private setIdle(preserveFinalResult = false): void {
    const wasListening = this.state !== "idle";
    this.state = "idle";
    if (!preserveFinalResult) this.detachBrowserRecognition();
    if (wasListening) this.deps.onListeningChange(false);
  }

  /**
   * Stop every live capture path and return to idle.
   *
   * Both the local-data clear and `dispose` need exactly this sequence, and a
   * copy that gets one step wrong leaves a recorder running or a browser
   * recognition attached. The caller owns the invalidation counters.
   */
  private releaseCapture(): void {
    if (this.browserLease) this.releaseBrowserLease(this.browserLease);
    const recognition = this.detachBrowserRecognition();
    if (recognition && this.state === "browser") {
      this.stopBrowserRecognition(recognition);
    }
    if (this.state === "provider" && !this.stopInFlight) {
      void discardNativeRecording();
    }
    if (this.state !== "idle") {
      this.setIdle();
    }
  }

  private abortForClear(): void {
    if (this.disposed) return;
    this.opGen++;
    this.busy = false;
    this.releaseCapture();
  }

  /**
   * Stop every active microphone path. Safe to call repeatedly. Any in-flight
   * operation is invalidated via `opGen`, so its deferred callbacks become
   * no-ops instead of firing after unmount.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeClear?.();
    this.unsubscribeClear = null;
    this.opGen++;
    this.releaseCapture();
  }
}
