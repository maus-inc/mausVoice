import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { invokeStopRecording } from "../../utils/recorded-audio.utils";

export type VoiceRecorderState = "idle" | "provider" | "browser";

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

  private async startProvider(gen: number): Promise<boolean> {
    try {
      await this.deps.invoke("start_recording", {
        args: {
          preferredMicrophone: this.deps.getPreferredMicrophone() ?? null,
        },
      });
      // The native recorder is now genuinely open. If `dispose` (or another
      // toggle) ran while we awaited mic init, release the recorder instead
      // of notifying the UI it is listening — otherwise the OS recording
      // indicator stays on behind a closed composer.
      if (gen !== this.opGen || this.disposed) {
        void this.deps.invoke("stop_recording").catch(() => undefined);
        return false;
      }
      this.state = "provider";
      this.deps.onListeningChange(true);
      return true;
    } catch {
      if (gen !== this.opGen || this.disposed) return false;
      this.deps.logger.warning(
        "Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition",
      );
    }
    return false;
  }

  private async start(gen: number): Promise<void> {
    if (this.deps.canUseProvider() && (await this.startProvider(gen))) return;

    if (gen !== this.opGen || this.disposed) {
      return;
    }

    if (this.deps.speechRecognitionSupported) {
      this.startBrowser();
      return;
    }

    this.deps.onError(this.deps.unsupportedMessage());
  }

  private startBrowser(): void {
    try {
      const recognition = this.deps.createSpeechRecognition();
      if (!recognition) {
        this.deps.onError(this.deps.unsupportedMessage());
        return;
      }
      this.recognition = recognition;
      recognition.lang = this.deps.getLang();
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      const alive = () => this.recognition === recognition && !this.disposed;
      recognition.onresult = (event) => {
        if (!alive()) return;
        const first = event.results[0]?.[0]?.transcript;
        if (first) this.deps.onTranscript(`${first}`.trim());
      };
      recognition.onend = () => {
        if (alive()) this.setIdle();
      };
      recognition.onerror = () => {
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
        const response = await invokeStopRecording((command) =>
          this.deps.invoke(command),
        );
        if (gen !== this.opGen || this.disposed) return null;
        return await this.transcribeProviderResponse(gen, response);
      } catch {
        if (gen !== this.opGen || this.disposed) return null;
        this.deps.logger.warning(
          "Voice Edit Mode: provider transcription failed",
        );
        if (this.deps.speechRecognitionSupported) {
          this.startBrowser();
          return null;
        }
        this.deps.onError(this.deps.unsupportedMessage());
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
   * Stop every active microphone path. Safe to call repeatedly. Any in-flight
   * operation is invalidated via `opGen`, so its deferred callbacks become
   * no-ops instead of firing after unmount.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opGen++;
    const recognition = this.detachBrowserRecognition();
    if (recognition && this.state === "browser") {
      this.stopBrowserRecognition(recognition);
    }
    if (this.state === "provider" && !this.stopInFlight) {
      void this.deps.invoke("stop_recording").catch(() => undefined);
    }
    if (this.state !== "idle") {
      this.setIdle();
    }
  }
}
