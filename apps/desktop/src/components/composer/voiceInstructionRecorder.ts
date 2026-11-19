import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { BrowserRecordingLease } from "../../utils/browser-recording-lease";
import {
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import {
  ActiveRecordingError,
  beginNativeRecording,
  waitForRecordingRelease,
  type NativeRecordingHandle,
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
  recordingUnavailableMessage: (operation: "start" | "stop") => string;
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
 * instead of firing callbacks on an unmounted component. A provider stop
 * takes its own handle before awaiting either native or transcription.
 */
export class VoiceInstructionRecorder {
  private state: VoiceRecorderState = "idle";
  private recognition: SpeechRecognitionLike | null = null;
  private browserLease: BrowserRecordingLease | null = null;
  private busy = false;
  private disposed = false;
  private opGen = 0;
  private providerHandle: NativeRecordingHandle | null = null;
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

  private isCurrent(gen: number): boolean {
    return gen === this.opGen && this.acceptsRecording();
  }

  private acceptsRecording(): boolean {
    return !this.disposed && !isLocalDataClearRequested();
  }

  async toggle(): Promise<void> {
    if (this.busy || !this.acceptsRecording()) return;
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
      if (this.isCurrent(gen)) {
        this.busy = false;
      }
    }
  }

  private trackAdmission(gen: number, handle: NativeRecordingHandle): void {
    // A reservation can outlive the component. Throwing here retires that
    // tuple without dispatching start_recording.
    if (!this.isCurrent(gen)) throw new Error("Recording start was cancelled");
    this.providerHandle = handle;
  }

  private async startProvider(
    gen: number,
  ): Promise<"started" | "blocked" | "unavailable"> {
    try {
      const { handle } = await beginNativeRecording(
        this.deps.getPreferredMicrophone(),
        {
          handleScoped: true,
          onAdmission: (handle) => this.trackAdmission(gen, handle),
        },
        this.deps.invoke,
      );
      return await this.finishProviderStart(gen, handle);
    } catch (error) {
      return this.providerStartFailure(gen, error);
    }
  }

  private async finishProviderStart(
    gen: number,
    handle: NativeRecordingHandle,
  ): Promise<"started" | "blocked"> {
    if (this.isCurrent(gen) && handle.isLive()) {
      this.state = "provider";
      this.deps.onListeningChange(true);
      return "started";
    }
    // A stop may have overtaken the start reply. Do not publish listening or
    // start a browser recognizer while native is winding down this admission.
    if (this.providerHandle === handle) this.providerHandle = null;
    await this.discardProvider(handle);
    if (this.isCurrent(gen))
      this.deps.onError(this.deps.recordingUnavailableMessage("start"));
    return "blocked";
  }

  private providerStartFailure(
    gen: number,
    error: unknown,
  ): "blocked" | "unavailable" {
    if (!this.isCurrent(gen)) return "blocked";
    this.providerHandle = null;
    if (error instanceof ActiveRecordingError) {
      this.deps.onError(this.deps.recordingUnavailableMessage("start"));
      return "blocked";
    }
    if (extractErrorMessage(error).includes("Local data is being cleared")) {
      return "blocked";
    }
    this.deps.logger.warning(
      "Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition",
    );
    return "unavailable";
  }

  private async start(gen: number): Promise<void> {
    if (isLocalDataClearRequested()) return;
    if (this.deps.canUseProvider()) {
      const outcome = await this.startProvider(gen);
      if (outcome === "started" || outcome === "blocked") return;
    }

    if (!this.isCurrent(gen)) {
      return;
    }

    await this.startBrowserOrReport(gen);
  }

  private async startBrowserOrReport(gen: number): Promise<void> {
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
      this.deps.onError(this.deps.recordingUnavailableMessage("start"));
      return;
    }
    const lease = new BrowserRecordingLease(this.deps.invoke);
    this.browserLease = lease;
    try {
      await lease.acquire();
    } catch {
      this.releaseBrowserLease(lease);
      if (this.isCurrent(gen)) {
        this.deps.onError(this.deps.recordingUnavailableMessage("start"));
      }
      return;
    }
    if (!this.isCurrent(gen)) {
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
      if (this.isCurrent(gen)) {
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
    const handle = this.providerHandle;
    this.providerHandle = null;
    if (!handle?.isLive()) {
      // A global teardown may already be stopping this admission. Do not
      // consume its audio; finish cleanup if that stop fails.
      if (handle) await this.discardProvider(handle);
      if (this.isCurrent(gen)) this.setIdle();
      return;
    }
    const transcript = await this.readProviderInstruction(handle, gen);
    this.finishProviderStop(gen, transcript);
  }

  private finishProviderStop(gen: number, transcript: string | null): void {
    if (!this.isCurrent(gen)) return;
    if (transcript) {
      this.deps.onTranscript(transcript);
    }
    this.deps.onResetLevels();
    if (this.state !== "browser") {
      this.setIdle();
    }
  }

  private async discardProvider(handle: NativeRecordingHandle): Promise<void> {
    try {
      // Only this UI waiter expires. Native still owns the admission until
      // its stop or discard acknowledges release (including a late reply).
      await waitForRecordingRelease(handle.discard());
    } catch {
      this.deps.logger.warning(
        "Voice Edit Mode: provider recording cleanup failed",
      );
    }
  }

  private async readProviderInstruction(
    handle: NativeRecordingHandle,
    gen: number,
  ): Promise<string | null> {
    let audio: StopRecordingResponse;
    try {
      audio = await handle.stop();
    } catch {
      // A rejected stop may leave this microphone open. Never start a
      // browser fallback or look up another recording to discard here.
      await this.discardProvider(handle);
      if (this.isCurrent(gen)) {
        this.deps.logger.warning(
          "Voice Edit Mode: provider recording failed to stop",
        );
        this.deps.onError(this.deps.recordingUnavailableMessage("stop"));
      }
      return null;
    }
    return this.isCurrent(gen)
      ? this.transcribeProviderResponse(gen, audio)
      : null;
  }

  private async transcribeProviderResponse(
    gen: number,
    response: StopRecordingResponse,
  ): Promise<string | null> {
    const { samples, sampleRate = 0 } = response;
    if (samples.length === 0 || sampleRate <= 0) {
      return null;
    }
    try {
      return (await this.deps.transcribe({ samples, sampleRate })).trim();
    } catch {
      if (!this.isCurrent(gen)) return null;
      this.deps.logger.warning(
        "Voice Edit Mode: provider transcription failed",
      );
      await this.startBrowserOrReport(gen);
      return null;
    }
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
    const handle = this.providerHandle;
    this.providerHandle = null;
    if (handle) {
      // Discard reports its own failure. A logger shutting down must not turn
      // that handled failure into a rejection after disposal.
      this.discardProvider(handle).catch(() => undefined);
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
