import { createAzureStreamingSession } from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  AZURE_PHRASE_LIST_BUDGET,
  buildProviderVocabulary,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { getStartupAbortReason } from "./provider-startup.utils";

export class AzureTranscriptionSession extends BaseApiTranscriptionSession {
  private readonly subscriptionKey: string;
  private readonly region: string;

  constructor(subscriptionKey: string, region: string) {
    super({
      providerLabel: "Azure",
      inferenceDevice: "API • Azure (Streaming)",
    });
    this.subscriptionKey = subscriptionKey;
    this.region = region;
  }

  async onRecordingStart(
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      getLogger().verbose("[Azure] Starting streaming session...");

      const state = getAppState();
      const language = await loadMyEffectiveDictationLanguage(state);
      if (signal?.aborted) throw getStartupAbortReason(signal);
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
        signal,
      });

      getLogger().verbose("[Azure] Streaming session started successfully");
    } catch (error) {
      getLogger().error("[Azure] Failed to start streaming:", error);
      throw error;
    }
  }

  supportsStreaming(): boolean {
    return false;
  }
}
