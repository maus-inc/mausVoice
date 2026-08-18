import type { StopRecordingResponse } from "../../types/transcription-session.types";

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
};

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export type VoiceInstructionRecorderDeps = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transcribe: (audio: {
    samples: number[];
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

  private async start(gen: number): Promise<void> {
    if (this.deps.canUseProvider()) {
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
          return;
        }
        this.state = "provider";
        this.deps.onListeningChange(true);
        return;
      } catch (error) {
        this.deps.logger.warning(
          `Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition (${error})`,
        );
      }
    }

    if (this.deps.speechRecognitionSupported) {
      this.startBrowser(gen);
      return;
    }

    this.deps.onError(this.deps.unsupportedMessage());
  }

  private startBrowser(gen: number): void {
    const recognition = this.deps.createSpeechRecognition();
    if (!recognition) return;

    recognition.lang = this.deps.getLang();
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    const alive = () => gen === this.opGen && !this.disposed;
    recognition.onresult = (event) => {
      if (!alive()) return;
      const first = event.results[0]?.[0]?.transcript;
      if (first) this.deps.onTranscript(`${first}`.trim());
    };
    recognition.onend = () => {
      if (!alive()) return;
      this.recognition = null;
      this.setIdle();
    };
    recognition.onerror = () => {
      if (!alive()) return;
      this.recognition = null;
      this.setIdle();
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      this.deps.logger.warning(
        `Voice Edit Mode: browser speech recognition failed to start (${error})`,
      );
      this.deps.onError(this.deps.unsupportedMessage());
      return;
    }
    this.state = "browser";
    this.deps.onListeningChange(true);
  }

  private async stop(gen: number): Promise<void> {
    if (this.state === "browser") {
      this.recognition?.stop();
      this.recognition = null;
      if (gen === this.opGen && !this.disposed) {
        this.setIdle();
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
        const response = (await this.deps.invoke(
          "stop_recording",
        )) as StopRecordingResponse;
        if (gen !== this.opGen || this.disposed) return null;
        return await this.transcribeProviderResponse(gen, response);
      } catch (error) {
        if (gen !== this.opGen || this.disposed) return null;
        this.deps.logger.warning(
          `Voice Edit Mode: provider transcription failed (${error})`,
        );
        if (this.deps.speechRecognitionSupported) {
          this.startBrowser(gen);
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
    const samples =
      response.samples instanceof Float32Array
        ? Array.from(response.samples)
        : response.samples;
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
    this.state = "idle";
    this.recognition = null;
    this.deps.onListeningChange(false);
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
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    if (this.state === "provider" && !this.stopInFlight) {
      void this.deps.invoke("stop_recording").catch(() => undefined);
    }
    if (this.state !== "idle") {
      this.setIdle();
    }
  }
}
