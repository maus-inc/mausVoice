import {
  ASSEMBLYAI_TRANSCRIPTION_MODELS,
  AZURE_OPENAI_MODELS,
  CEREBRAS_MODELS,
  CLAUDE_MODELS,
  DEEPGRAM_TRANSCRIPTION_MODELS,
  DEEPSEEK_MODELS,
  GEMINI_GENERATE_TEXT_MODELS,
  GEMINI_TRANSCRIPTION_MODELS,
  GLADIA_TRANSCRIPTION_MODELS,
  GENERATE_TEXT_MODELS,
  OPENAI_GENERATE_TEXT_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  TRANSCRIPTION_MODELS,
} from "@maus-inc/voice-ai";
import {
  createOpenAICompatibleFetch,
  secureFetch as fetch,
} from "../utils/secure-fetch.utils";
import { getLogger } from "../utils/log.utils";
import { getOllamaHeaders } from "../utils/ollama.utils";
import {
  appendOpenAICompatiblePath,
  buildOpenAICompatibleUrl,
} from "../utils/openai-compatible.utils";
import { BaseRepo } from "./base.repo";

type OpenAIListResponse = {
  data?: Array<{ id?: string }>;
};

type GeminiListResponse = {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
};

export type FetchModelsOptions = {
  apiKey?: string;
  apiKeyId?: string;
  baseUrl?: string;
  includeV1Path?: boolean | null;
};

export abstract class BaseModelProviderRepo extends BaseRepo {
  abstract supportsGenerativeTextModels(): boolean;
  abstract supportsTranscriptionModels(): boolean;
  abstract getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
  abstract getTranscriptionModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
}

const logModelDiscoveryFailure = (provider: string, reason: string): void => {
  // Do not log request URLs or caught errors: some providers put credentials
  // in the query string, and native transport errors may echo those URLs.
  getLogger().verbose(`${provider} model discovery failed (${reason})`);
};

const logModelDiscoveryResponseFailure = (
  provider: string,
  response: Response,
): void => {
  const statusText = response.statusText.trim();
  const reason = [`HTTP ${response.status}`, statusText]
    .filter(Boolean)
    .join(" ");
  logModelDiscoveryFailure(provider, reason);
};

// Shared tail of every OpenAI-shaped /models fetch: log a non-OK response,
// otherwise map the `data` array to sorted model ids.
const readModelListResponse = async (
  provider: string,
  response: Response,
): Promise<string[]> => {
  if (!response.ok) {
    logModelDiscoveryResponseFailure(provider, response);
    return [];
  }
  const payload = (await response.json()) as OpenAIListResponse;
  return (payload.data ?? [])
    .map((m) => (m.id ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
};

async function fetchOpenAICompatibleModels(
  provider: string,
  url: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return await readModelListResponse(provider, response);
  } catch {
    logModelDiscoveryFailure(provider, "request or response parsing failed");
    return [];
  }
}

function isWhisperModel(modelId: string): boolean {
  return modelId.includes("whisper");
}

function isGroqGenerativeModel(modelId: string): boolean {
  return !["orpheus", "prompt-guard", "safeguard", "whisper"].some((marker) =>
    modelId.includes(marker),
  );
}

function isOpenAITranscriptionModel(modelId: string): boolean {
  return (
    modelId === "whisper-1" ||
    modelId.startsWith("gpt-4o-transcribe") ||
    modelId.startsWith("gpt-4o-mini-transcribe")
  );
}

function isOpenAIGenerativeModel(modelId: string): boolean {
  if (!/^(gpt-|o\d)/.test(modelId)) return false;
  return ![
    "audio",
    "embedding",
    "image",
    "live",
    "moderation",
    "realtime",
    "transcribe",
    "tts",
    "whisper",
  ].some((marker) => modelId.includes(marker));
}

function isGeneralGeminiModel(modelId: string): boolean {
  if (!modelId.startsWith("gemini-")) return false;
  return ![
    "-audio",
    "-computer-use",
    "-embedding",
    "-image",
    "-live",
    "-native-audio",
    "-omni-",
    "-robotics",
    "-tts",
  ].some((marker) => modelId.includes(marker));
}

function isGeminiTranscriptionModel(modelId: string): boolean {
  // Gemini transcription is done via generateContent with audio input, so
  // the same general-model filter applies. A few variants are then dropped
  // because they do not support the audio-input transcription path.
  if (!isGeneralGeminiModel(modelId)) return false;
  // Exclude reasoning/search-augmented Gemini variants, which are not served
  // through the audio-input generateContent transcription path.
  return !["-thinking", "-search"].some((marker) => modelId.includes(marker));
}

export class GroqModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "Groq",
      "https://api.groq.com/openai/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    const models = fetched.filter(isGroqGenerativeModel);
    return models.length > 0 ? models : [...GENERATE_TEXT_MODELS];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    const models = fetched.filter(isWhisperModel);
    return models.length > 0 ? models : [...TRANSCRIPTION_MODELS];
  }
}

export class OpenAIModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "OpenAI",
      "https://api.openai.com/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const models = (await this.fetchModels(options)).filter(
      isOpenAIGenerativeModel,
    );
    return models.length > 0 ? models : [...OPENAI_GENERATE_TEXT_MODELS];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const models = (await this.fetchModels(options)).filter(
      isOpenAITranscriptionModel,
    );
    return models.length > 0 ? models : [...OPENAI_TRANSCRIPTION_MODELS];
  }
}

export class ClaudeModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    try {
      const response = await fetch(
        "https://api.anthropic.com/v1/models?limit=100",
        {
          headers: {
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
      );
      return await readModelListResponse("Claude", response);
    } catch {
      logModelDiscoveryFailure("Claude", "request or response parsing failed");
      return [];
    }
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...CLAUDE_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class CerebrasModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "Cerebras",
      "https://api.cerebras.ai/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...CEREBRAS_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class DeepSeekModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "DeepSeek",
      "https://api.deepseek.com/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...DEEPSEEK_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class GeminiModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...GEMINI_GENERATE_TEXT_MODELS];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = (await this.fetchModels(options)).filter(
      isGeminiTranscriptionModel,
    );
    return fetched.length > 0 ? fetched : [...GEMINI_TRANSCRIPTION_MODELS];
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        { headers: { "x-goog-api-key": options.apiKey } },
      );
      if (!response.ok) {
        logModelDiscoveryResponseFailure("Gemini", response);
        return [];
      }
      const payload = (await response.json()) as GeminiListResponse;
      return (payload.models ?? [])
        .filter((m) =>
          (m.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((m) => (m.name ?? "").replace(/^models\//, "").trim())
        .filter(isGeneralGeminiModel)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      logModelDiscoveryFailure("Gemini", "request or response parsing failed");
      return [];
    }
  }
}

export class AzureModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...AZURE_OPENAI_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey || !options.baseUrl) return [];
    const baseUrl = options.baseUrl.replace(/\/$/, "");
    const response = await fetch(
      `${baseUrl}/openai/models?api-version=2024-10-21`,
      {
        headers: { "api-key": options.apiKey },
      },
    );
    return readModelListResponse("Azure OpenAI", response);
  }
}

export class OllamaModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  // Stock Ollama has no speech-to-text endpoint: its OpenAI-compatible
  // surface covers chat, completions, models, embeddings, and responses
  // only, and whisper/STT support has not shipped upstream. Reporting
  // transcription capability here previously let Ollama appear in the
  // transcription selector while getTranscribeAudioRepo() had no Ollama
  // branch. Keep it false so capability filtering and dispatch agree.
  supportsTranscriptionModels(): boolean {
    return false;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    return this.fetchModels(options);
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/api/tags", options.baseUrl).href, {
      headers: getOllamaHeaders(options.apiKey),
    });
    if (!response.ok) {
      logModelDiscoveryResponseFailure("Ollama", response);
      return [];
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    return (payload.models ?? [])
      .map((m) => (m.name ?? "").trim())
      .filter(Boolean);
  }
}

export class OpenAICompatibleModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    return this.fetchModels(options);
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    return this.fetchModels(options);
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl || !options.apiKeyId) return [];
    const apiBaseUrl = buildOpenAICompatibleUrl(
      options.baseUrl,
      options.includeV1Path,
    );
    const customFetch = createOpenAICompatibleFetch(options.apiKeyId);
    const response = await customFetch(
      appendOpenAICompatiblePath(apiBaseUrl, "models"),
      { headers: getOllamaHeaders(options.apiKey) },
    );
    return readModelListResponse("OpenAI-compatible", response);
  }
}

export class SpeachesModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/v1/models", options.baseUrl).href);
    return readModelListResponse("Speaches", response);
  }
}

export class OpenRouterModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "OpenRouter",
      "https://openrouter.ai/api/v1/models",
      options.apiKey,
    );
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class AldeaModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class AssemblyAIModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [...ASSEMBLYAI_TRANSCRIPTION_MODELS];
  }
}

export class ElevenLabsModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class GladiaModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [...GLADIA_TRANSCRIPTION_MODELS];
  }
}

export class XaiModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    // xAI's dedicated /v1/stt API does not accept a model parameter.
    return [];
  }
}

export class DeepgramModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [...DEEPGRAM_TRANSCRIPTION_MODELS];
  }
}
