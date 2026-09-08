import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
  Nullable,
  OpenRouterProviderRouting,
} from "@maus-inc/types";
import {
  azureOpenAIGenerateText,
  azureOpenaiStreamChat,
  claudeGenerateTextResponse,
  claudeStreamChat,
  CLAUDE_MODELS,
  ClaudeModel,
  cerebrasGenerateTextResponse,
  cerebrasStreamChat,
  CEREBRAS_MODELS,
  CerebrasModel,
  deepseekGenerateTextResponse,
  deepseekStreamChat,
  DEEPSEEK_MODELS,
  DeepseekModel,
  GeminiGenerateTextModel,
  geminiGenerateTextResponse,
  geminiStreamChat,
  GENERATE_TEXT_MODELS,
  GenerateTextModel,
  groqGenerateTextResponse,
  groqStreamChat,
  OpenAIGenerateTextModel,
  openaiGenerateTextResponse,
  openaiStreamChat,
  OPENROUTER_DEFAULT_MODEL,
  openrouterGenerateTextResponse,
  openrouterStreamChat,
} from "@maus-inc/voice-ai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { PostProcessingMode } from "../types/ai.types";
import { BaseRepo } from "./base.repo";

export type GenerateTextInput = {
  system?: Nullable<string>;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  /**
   * Cancellation handle for the underlying provider request. Threaded through
   * every provider so a timed out post-processing call stops consuming quota
   * instead of running to completion in the background. Providers receiving a
   * signal also stop retrying (a caller deadline is not a transient failure).
   */
  signal?: AbortSignal;
};

export type GenerateTextMetadata = {
  postProcessingMode?: Nullable<PostProcessingMode>;
  inferenceDevice?: Nullable<string>;
  /** Resolved model id actually used for the request (post-fallback). */
  model?: Nullable<string>;
};

export type GenerateTextOutput = {
  text: string;
  metadata?: GenerateTextMetadata;
};

export abstract class BaseGenerateTextRepo extends BaseRepo {
  abstract generateText(input: GenerateTextInput): Promise<GenerateTextOutput>;
  abstract streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent>;
}

export class GroqGenerateTextRepo extends BaseGenerateTextRepo {
  private groqApiKey: string;
  private model: GenerateTextModel;
  private fallbackModel: GenerateTextModel = "qwen/qwen3.6-27b";

  constructor(apiKey: string, model: string | null) {
    super();
    this.groqApiKey = apiKey;
    // Membership test runs against the widened list because
    // `GenerateTextModel` also carries runtime-discovered model ids, which
    // are not in the literal `GENERATE_TEXT_MODELS` tuple.
    const allowedModels: readonly string[] = GENERATE_TEXT_MODELS;
    this.model =
      model !== null && allowedModels.includes(model)
        ? (model as GenerateTextModel)
        : "openai/gpt-oss-20b";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const { response, model } = await this.generateWithFallback(input);

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Groq",
        model,
      },
    };
  }

  private async generateWithFallback(input: GenerateTextInput) {
    try {
      const response = await groqGenerateTextResponse({
        apiKey: this.groqApiKey,
        model: this.model,
        prompt: input.prompt,
        system: input.system ?? undefined,
        jsonResponse: input.jsonResponse,
        maxTokens: input.maxTokens,
        signal: input.signal,
      });
      return { response, model: this.model };
    } catch (error) {
      // An aborted request must never fall back: the abort is the caller's
      // deadline decision, not a provider failure worth another attempt.
      if (input.signal?.aborted || this.model === this.fallbackModel) {
        throw error;
      }

      const response = await groqGenerateTextResponse({
        apiKey: this.groqApiKey,
        model: this.fallbackModel,
        prompt: input.prompt,
        system: input.system ?? undefined,
        jsonResponse: input.jsonResponse,
        maxTokens: input.maxTokens,
        signal: input.signal,
      });
      return { response, model: this.fallbackModel };
    }
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* groqStreamChat({
      apiKey: this.groqApiKey,
      model: this.model,
      input,
    });
  }
}

export class OpenAIGenerateTextRepo extends BaseGenerateTextRepo {
  private openaiApiKey: string;
  private model: OpenAIGenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.openaiApiKey = apiKey;
    this.model = (model as OpenAIGenerateTextModel) ?? "gpt-4o-mini";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      apiKey: this.openaiApiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenAI",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.openaiApiKey,
      model: this.model,
      input,
    });
  }
}

/**
 * Ollama and the generic OpenAI-compatible endpoint speak the same wire
 * protocol, so they differ only in their default API key and the device label
 * shown in transcription history. Sharing the calls keeps one implementation.
 */
abstract class OpenAICompatibleBaseGenerateTextRepo extends BaseGenerateTextRepo {
  protected baseUrl: string;
  protected model: string;
  protected apiKey: string;
  protected abstract readonly inferenceDevice: string;

  constructor(url: string, model: string, apiKey: string) {
    super();
    this.baseUrl = url;
    this.model = model;
    this.apiKey = apiKey;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      customFetch: tauriFetch,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: this.inferenceDevice,
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class OllamaGenerateTextRepo extends OpenAICompatibleBaseGenerateTextRepo {
  protected readonly inferenceDevice = "API • Ollama";

  constructor(url: string, model: string, apiKey?: string) {
    super(url, model, apiKey || "ollama");
  }
}

export class OpenAICompatibleGenerateTextRepo extends OpenAICompatibleBaseGenerateTextRepo {
  protected readonly inferenceDevice = "API • OpenAI Compatible";

  constructor(url: string, model: string, apiKey?: string) {
    super(url, model, apiKey || "");
  }
}

export class OpenRouterGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: string;
  private providerRouting?: OpenRouterProviderRouting;

  constructor(
    apiKey: string,
    model: string | null,
    providerRouting?: OpenRouterProviderRouting,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? OPENROUTER_DEFAULT_MODEL;
    this.providerRouting = providerRouting;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openrouterGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      providerRouting: this.providerRouting,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenRouter",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openrouterStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class AzureOpenAIGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private endpoint: string;
  private deploymentName: string;

  constructor(apiKey: string, endpoint: string, deploymentName: string | null) {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.deploymentName = deploymentName ?? "gpt-4o-mini";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await azureOpenAIGenerateText({
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      deploymentName: this.deploymentName,
      system: input.system ?? undefined,
      prompt: input.prompt,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Azure OpenAI",
        model: this.deploymentName,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* azureOpenaiStreamChat({
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      deploymentName: this.deploymentName,
      input,
    });
  }
}

export class DeepseekGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: DeepseekModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as DeepseekModel) ?? DEEPSEEK_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await deepseekGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • DeepSeek",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* deepseekStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class GeminiGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: GeminiGenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as GeminiGenerateTextModel) ?? "gemini-2.5-flash";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await geminiGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Gemini",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* geminiStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class ClaudeGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: ClaudeModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as ClaudeModel) ?? CLAUDE_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await claudeGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Claude",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* claudeStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class CerebrasGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: CerebrasModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as CerebrasModel) ?? CEREBRAS_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await cerebrasGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Cerebras",
        model: this.model,
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* cerebrasStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}
