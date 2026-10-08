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
  isGeminiTranscribeModel as isGeminiTranscribeModelFromVoiceAI,
  OPENAI_GENERATE_TEXT_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  TRANSCRIPTION_MODELS,
  isGroqGenerativeModelId,
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
  nextPageToken?: string;
};

export type FetchModelsOptions = {
  apiKey?: string;
  apiKeyId?: string;
  baseUrl?: string;
  includeV1Path?: boolean | null;
};

export abstract class BaseModelProviderRepo extends BaseRepo {
  abstract readonly supportsGenerativeTextModels: boolean;
  abstract readonly supportsTranscriptionModels: boolean;
  abstract getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
  abstract getTranscriptionModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
}

/**
 * A provider that offers no model of a kind resolves with an empty list rather
 * than rejecting, so every caller's fetch path is the same for every provider.
 * Discovery is async because the providers that talk to a /models endpoint
 * declare that shape; these keep it without an async function that never
 * awaits, which would turn a synchronous failure into a synchronous throw that
 * a `.catch()` upstream never sees.
 */
const noModels = (): Promise<string[]> => Promise.resolve([]);

/** The same shape for a provider whose catalogue is fixed at build time. */
const staticModels = (models: readonly string[]): Promise<string[]> =>
  Promise.resolve([...models]);

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

const GEMINI_EXCLUDED_MODALITY_MARKERS = [
  "-audio",
  "-computer-use",
  "-embedding",
  "-image",
  "-live",
  "-native-audio",
  "-omni-",
  "-robotics",
  "-tts",
] as const;

const GEMINI_REASONING_MARKERS = ["-thinking", "-search"] as const;

function isGeneralGeminiModel(modelId: string): boolean {
  // fetchModels returns union of transcription + generative; narrowing only
  // happens in getGenerativeTextModels. Keep marker list shared with
  // isGeminiTranscriptionModel to avoid drift.
  if (!modelId.startsWith("gemini-")) return false;
  return ![...GEMINI_EXCLUDED_MODALITY_MARKERS, "-transcribe"].some((marker) =>
    modelId.includes(marker),
  );
}

function isGeminiTranscriptionModel(modelId: string): boolean {
  if (!modelId.startsWith("gemini-")) return false;
  if (
    GEMINI_EXCLUDED_MODALITY_MARKERS.some((marker) => modelId.includes(marker))
  ) {
    return false;
  }
  // Use shared predicate for dedicated "-transcribe" detection (single source of truth).
  if (isGeminiTranscribeModelFromVoiceAI(modelId)) {
    return true;
  }
  // General Gemini models with audio input are also transcription-capable.
  // Exclude reasoning/search-augmented variants not served via audio path.
  return !GEMINI_REASONING_MARKERS.some((marker) => modelId.includes(marker));
}

type GeminiModel = NonNullable<GeminiListResponse["models"]>[number];

const fetchGeminiModelPage = async (
  apiKey: string,
  pageToken?: string,
): Promise<GeminiListResponse | null> => {
  const url = new URL(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  url.searchParams.set("pageSize", "1000");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const response = await fetch(url.toString(), {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    logModelDiscoveryResponseFailure("Gemini", response);
    return null;
  }
  return (await response.json()) as GeminiListResponse;
};

const fetchGeminiModelCatalog = async (
  apiKey: string,
): Promise<GeminiModel[] | null> => {
  const models: GeminiModel[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  do {
    const payload = await fetchGeminiModelPage(apiKey, pageToken);
    if (!payload) return null;
    models.push(...(payload.models ?? []));

    const nextPageToken = payload.nextPageToken;
    if (!nextPageToken) return models;
    if (seenPageTokens.has(nextPageToken)) {
      logModelDiscoveryFailure(
        "Gemini",
        "model discovery returned a repeated page token",
      );
      return null;
    }

    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);

  return models;
};

const filterGeminiModelCatalog = (models: GeminiModel[]): string[] => {
  if (models.length === 0) {
    getLogger().verbose("Gemini model discovery returned empty models array");
    return [];
  }

  const filtered = models
    .filter((model) =>
      (model.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((model) => (model.name ?? "").replace(/^models\//, "").trim())
    .filter((id) => isGeneralGeminiModel(id) || isGeminiTranscriptionModel(id))
    .sort((a, b) => a.localeCompare(b));
  if (filtered.length === 0) {
    getLogger().verbose(
      "Gemini model discovery filtered to 0 after marker checks",
    );
  }
  return filtered;
};

export class GroqModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = true;

  private fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
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
    const models = fetched.filter(isGroqGenerativeModelId);
    return models.length > 0 ? models : [...GENERATE_TEXT_MODELS];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    const models = fetched.filter(isWhisperModel);
    return models.length > 0 ? models : [...TRANSCRIPTION_MODELS];
  }
}

export class OpenAIModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = true;

  private fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
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
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = false;

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

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
  }
}

export class CerebrasModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = false;

  private fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
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

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
  }
}

export class DeepSeekModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = false;

  private fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
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

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
  }
}

export class GeminiModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = true;

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = (await this.fetchModels(options)).filter(
      isGeneralGeminiModel,
    );
    return fetched.length > 0 ? fetched : [...GEMINI_GENERATE_TEXT_MODELS];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = (await this.fetchModels(options)).filter(
      isGeminiTranscriptionModel,
    );
    // Trust a non-empty discovered transcription catalog; use the static list
    // only when discovery provides no transcription options.
    return fetched.length > 0 ? fetched : [...GEMINI_TRANSCRIPTION_MODELS];
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    // Returns the union of transcription and generative models; callers narrow
    // it by capability before using the discovered catalog.
    if (!options.apiKey) return [];
    try {
      const models = await fetchGeminiModelCatalog(options.apiKey);
      return models ? filterGeminiModelCatalog(models) : [];
    } catch {
      logModelDiscoveryFailure("Gemini", "request or response parsing failed");
      return [];
    }
  }
}

export class AzureModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = false;

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...AZURE_OPENAI_MODELS];
  }

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
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
  readonly supportsGenerativeTextModels = true;

  // Stock Ollama has no speech-to-text endpoint: its OpenAI-compatible
  // surface covers chat, completions, models, embeddings, and responses
  // only, and whisper/STT support has not shipped upstream. Reporting
  // transcription capability here previously let Ollama appear in the
  // transcription selector while getTranscribeAudioRepo() had no Ollama
  // branch. Keep it false so capability filtering and dispatch agree.
  readonly supportsTranscriptionModels = false;

  getGenerativeTextModels(options: FetchModelsOptions): Promise<string[]> {
    return this.fetchModels(options);
  }

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
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
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(options: FetchModelsOptions): Promise<string[]> {
    return this.fetchModels(options);
  }

  getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
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
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/v1/models", options.baseUrl).href);
    return readModelListResponse("Speaches", response);
  }
}

export class OpenRouterModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = true;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
    return fetchOpenAICompatibleModels(
      "OpenRouter",
      "https://openrouter.ai/api/v1/models",
      options.apiKey,
    );
  }

  getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return noModels();
    // OpenRouter deliberately omits STT models from its default text-model
    // catalog. Request its transcription modality explicitly so a provider
    // advertised in the transcription selector has a usable model picker.
    return fetchOpenAICompatibleModels(
      "OpenRouter",
      "https://openrouter.ai/api/v1/models?output_modalities=transcription",
      options.apiKey,
    );
  }
}

export class AldeaModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
  }
}

export class AssemblyAIModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    return staticModels(ASSEMBLYAI_TRANSCRIPTION_MODELS);
  }
}

export class ElevenLabsModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    return noModels();
  }
}

export class GladiaModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    return staticModels(GLADIA_TRANSCRIPTION_MODELS);
  }
}

export class XaiModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    // xAI's dedicated /v1/stt API does not accept a model parameter.
    return noModels();
  }
}

export class DeepgramModelProviderRepo extends BaseModelProviderRepo {
  readonly supportsGenerativeTextModels = false;

  readonly supportsTranscriptionModels = true;

  getGenerativeTextModels(): Promise<string[]> {
    return noModels();
  }

  getTranscriptionModels(): Promise<string[]> {
    return staticModels(DEEPGRAM_TRANSCRIPTION_MODELS);
  }
}
