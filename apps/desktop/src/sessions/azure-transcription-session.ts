import {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { createAzureStreamingSession } from "@maus-inc/voice-ai";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { finalizeStreamingSession } from "../utils/streaming-session.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";

export class AzureTranscriptionSession extends BaseApiTranscriptionSession {
  private readonly subscriptionKey: string;
  private readonly region: string;
  private unlisten: UnlistenFn | null = null;
  private receivedChunkCount = 0;

  constructor(subscriptionKey: string, region: string) {
    super({
      providerLabel: "Azure",
      inferenceDevice: "API • Azure (Streaming)",
    });
    this.subscriptionKey = subscriptionKey;
    this.region = region;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      getLogger().verbose("[Azure] Starting streaming session...");

      const state = getAppState();
      const language = await loadMyEffectiveDictationLanguage(state);
      const dictionaryEntries = collectDictionaryEntries(state);
      const prompt = buildLocalizedTranscriptionPrompt({
        entries: dictionaryEntries,
        dictationLanguage: language,
        state,
      });

      this.streamSession = await createAzureStreamingSession({
        subscriptionKey: this.subscriptionKey,
        region: this.region,
        sampleRate,
        language,
        prompt: prompt || undefined,
      });

      this.unlisten = await listen<{ samples: number[] }>(
        "audio_chunk",
        (event) => {
          this.receivedChunkCount++;
          if (
            this.receivedChunkCount <= 3 ||
            this.receivedChunkCount % 10 === 0
          ) {
            getLogger().verbose(
              `[Azure] Received chunk #${this.receivedChunkCount}, samples:`,
              event.payload.samples.length,
            );
          }

          if (this.streamSession?.writeAudioChunk) {
            try {
              const typedChunk =
                event.payload.samples instanceof Float32Array
                  ? event.payload.samples
                  : Float32Array.from(event.payload.samples);

              this.streamSession.writeAudioChunk(typedChunk);
            } catch (error) {
              getLogger().error("[Azure] Error writing audio chunk:", error);
            }
          }
        },
      );

      getLogger().verbose("[Azure] Streaming session started successfully");
    } catch (error) {
      getLogger().error("[Azure] Failed to start streaming:", error);
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    return finalizeStreamingSession({
      session: this.streamSession,
      providerLabel: "Azure",
      log: getLogger().verbose.bind(getLogger()),
    });
  }

  cleanup(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    super.cleanup();
  }

  supportsStreaming(): boolean {
    return false;
  }
}
