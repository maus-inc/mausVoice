import { createAzureStreamingSession } from "@maus-inc/voice-ai";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
import { ensureFloat32Array } from "../utils/audio.utils";
import { getLogger } from "../utils/log.utils";
import {
  AZURE_PHRASE_LIST_BUDGET,
  buildProviderVocabulary,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
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
      // Azure's phrase list takes plain terms (multi-word phrases included),
      // never the localized prompt sentence, because instruction words
      // like "Glossary:" or "transcribing" would bias recognition.
      const { terms: phrases, warning } = buildProviderVocabulary(
        collectDictionaryEntries(state),
        AZURE_PHRASE_LIST_BUDGET,
        "Azure",
      );
      if (warning) {
        getLogger().warning(warning);
      }

      this.streamSession = await createAzureStreamingSession({
        subscriptionKey: this.subscriptionKey,
        region: this.region,
        sampleRate,
        language,
        phrases,
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
              const typedChunk = ensureFloat32Array(event.payload.samples);

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
