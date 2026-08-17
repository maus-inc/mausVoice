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
  canUseProvider: boolean;
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
 * Key invariant: when provider transcription fails and we fall back to the
 * browser recognizer, we must NOT reset the listening flag to idle — the
 * browser recognizer keeps running and owns the listening state until its
 * `onend`/`onerror` fires. Stopping native recording and the browser
 * recognizer on dispose/unmount guarantees no microphone is left active.
 */
export class VoiceInstructionRecorder {
  private state: VoiceRecorderState = "idle";
  private recognition: SpeechRecognitionLike | null = null;
  private busy = false;

  constructor(private readonly deps: VoiceInstructionRecorderDeps) {}

  getState(): VoiceRecorderState {
    return this.state;
  }

  async toggle(): Promise<void> {
    if (this.busy) return;
    if (this.state !== "idle") {
      await this.stop();
      return;
    }
    this.busy = true;
    try {
      await this.start();
    } finally {
      this.busy = false;
    }
  }

  private async start(): Promise<void> {
    if (this.deps.canUseProvider) {
      try {
        await this.deps.invoke("start_recording", {
          args: {
            preferredMicrophone: this.deps.getPreferredMicrophone() ?? null,
          },
        });
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
      this.startBrowser();
      return;
    }

    this.deps.onError(this.deps.unsupportedMessage());
  }

  private startBrowser(): void {
    const recognition = this.deps.createSpeechRecognition();
    if (!recognition) return;

    recognition.lang = this.deps.getLang();
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const first = event.results[0]?.[0]?.transcript;
      if (first) this.deps.onTranscript(`${first}`.trim());
    };
    recognition.onend = () => {
      this.recognition = null;
      this.setIdle();
    };
    recognition.onerror = () => {
      this.recognition = null;
      this.setIdle();
    };

    this.recognition = recognition;
    this.state = "browser";
    this.deps.onListeningChange(true);
    recognition.start();
  }

  private async stop(): Promise<void> {
    if (this.state === "browser") {
      this.recognition?.stop();
      this.recognition = null;
      return;
    }

    if (this.state === "provider") {
      await this.stopProviderRecording();
    }
  }

  /**
   * Stop native provider recording, deliver its transcript, then reset levels.
   * If transcription fell back to the browser recognizer, that recognizer owns
   * the listening state, so we only return to idle on the genuine paths.
   */
  private async stopProviderRecording(): Promise<void> {
    const transcript = await this.transcribeProviderRecording();
    if (transcript) {
      this.deps.onTranscript(transcript);
    }
    this.deps.onResetLevels();
    if (this.state !== "browser") {
      this.setIdle();
    }
  }

  private async transcribeProviderRecording(): Promise<string | null> {
    try {
      const response = (await this.deps.invoke(
        "stop_recording",
      )) as StopRecordingResponse;
      return await this.transcribeProviderResponse(response);
    } catch (error) {
      this.deps.logger.warning(
        `Voice Edit Mode: provider transcription failed (${error})`,
      );
      if (this.deps.speechRecognitionSupported) {
        this.startBrowser();
        return null;
      }
      this.deps.onError(this.deps.unsupportedMessage());
      return null;
    }
  }

  private async transcribeProviderResponse(
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
    return transcript || null;
  }

  private setIdle(): void {
    this.state = "idle";
    this.recognition = null;
    this.deps.onListeningChange(false);
  }

  /** Stop every active microphone path. Safe to call repeatedly (unmount/Cancel/Insert). */
  dispose(): void {
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    if (this.state === "provider") {
      void this.deps.invoke("stop_recording").catch(() => undefined);
    }
    if (this.state !== "idle") {
      this.setIdle();
    }
  }
}
