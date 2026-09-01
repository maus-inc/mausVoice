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
  ClaudeModel,
  CLAUDE_MODELS,
  cerebrasGenerateTextResponse,
  cerebrasStreamChat,
  CerebrasModel,
  CEREBRAS_MODELS,
  type CustomFetch,
  deepseekGenerateTextResponse,
  deepseekStreamChat,
  DeepseekModel,
  DEEPSEEK_MODELS,
  GeminiGenerateTextModel,
  GEMINI_GENERATE_TEXT_MODELS,
  geminiGenerateTextResponse,
  geminiStreamChat,
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
import {
  createOpenAICompatibleFetch,
  secureFetch as tauriFetch,
} from "../utils/secure-fetch.utils";
import { PostProcessingMode } from "../types/ai.types";
import { BaseRepo } from "./base.repo";

export type GenerateTextInput = {
  system?: Nullable<string>;
  prompt: string;
  jsonResponse?: JsonResponse;
<<<<<<< HEAD
  maxTokens?: number;
=======
  signal?: AbortSignal;
>>>>>>> origin/fix/superfix-review-findings
};

export type GenerateTextMetadata = {
  postProcessingMode?: Nullable<PostProcessingMode>;
  inferenceDevice?: Nullable<string>;
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
  private fallbackModel: GenerateTextModel = "openai/gpt-oss-120b";
  private customFetch?: CustomFetch;

  constructor(
    apiKey: string,
    model: string | null,
    customFetch: CustomFetch | null = tauriFetch,
  ) {
    super();
    this.groqApiKey = apiKey;
    this.model = model ?? "openai/gpt-oss-20b";
    this.customFetch = customFetch ?? undefined;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await this.generateWithFallback(input);

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Groq",
      },
    };
  }

  private async generateWithFallback(input: GenerateTextInput) {
    try {
      return await groqGenerateTextResponse({
        apiKey: this.groqApiKey,
        model: this.model,
        prompt: input.prompt,
        system: input.system ?? undefined,
        jsonResponse: input.jsonResponse,
<<<<<<< HEAD
        maxTokens: input.maxTokens,
=======
        signal: input.signal,
        customFetch: this.customFetch,
>>>>>>> origin/fix/superfix-review-findings
      });
    } catch (error) {
      if (input.signal?.aborted || this.model === this.fallbackModel) {
        throw error;
      }

      return groqGenerateTextResponse({
        apiKey: this.groqApiKey,
        model: this.fallbackModel,
        prompt: input.prompt,
        system: input.system ?? undefined,
        jsonResponse: input.jsonResponse,
<<<<<<< HEAD
        maxTokens: input.maxTokens,
=======
        signal: input.signal,
        customFetch: this.customFetch,
>>>>>>> origin/fix/superfix-review-findings
      });
    }
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* groqStreamChat({
      apiKey: this.groqApiKey,
      model: this.model,
      input,
      customFetch: this.customFetch,
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
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenAI",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.openaiApiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class OllamaGenerateTextRepo extends BaseGenerateTextRepo {
  private ollamaUrl: string;
  private model: string;
  private apiKey: string;

  constructor(url: string, model: string, apiKey?: string) {
    super();
    this.ollamaUrl = url;
    this.model = model;
    this.apiKey = apiKey || "ollama";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.ollamaUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      customFetch: tauriFetch,
      maxTokens: input.maxTokens,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Ollama",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.apiKey,
      baseUrl: this.ollamaUrl,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class OpenAICompatibleGenerateTextRepo extends BaseGenerateTextRepo {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private customFetch: typeof tauriFetch;

  constructor(apiKeyId: string, url: string, model: string, apiKey?: string) {
    super();
    this.baseUrl = url;
    this.model = model;
    this.apiKey = apiKey || "";
    this.customFetch = createOpenAICompatibleFetch(apiKeyId);
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
<<<<<<< HEAD
      customFetch: tauriFetch,
      maxTokens: input.maxTokens,
=======
      customFetch: this.customFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenAI Compatible",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      input,
      customFetch: this.customFetch,
    });
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
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenRouter",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openrouterStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
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
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Azure OpenAI",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* azureOpenaiStreamChat({
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      deploymentName: this.deploymentName,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class DeepseekGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: DeepseekModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? DEEPSEEK_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await deepseekGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • DeepSeek",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* deepseekStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class GeminiGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: GeminiGenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? GEMINI_GENERATE_TEXT_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await geminiGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      signal: input.signal,
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Gemini",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* geminiStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class ClaudeGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: ClaudeModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? CLAUDE_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await claudeGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Claude",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* claudeStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class CerebrasGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: CerebrasModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? CEREBRAS_MODELS[0];
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await cerebrasGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
<<<<<<< HEAD
      maxTokens: input.maxTokens,
=======
      customFetch: tauriFetch,
>>>>>>> origin/fix/superfix-review-findings
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Cerebras",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* cerebrasStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}
