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
  GEMINI_GENERATE_TEXT_MODELS,
  GeminiGenerateTextModel,
  geminiGenerateTextResponse,
  geminiStreamChat,
  GENERATE_TEXT_MODELS,
  GenerateTextModel,
  GROQ_DEFAULT_GENERATE_TEXT_MODEL,
  groqGenerateTextResponse,
  GroqGenerateResponseOutput,
  groqStreamChat,
  isGroqAccountScopedError,
  isGroqGenerativeModelId,
  isGroqModelUnavailableError,
  OpenAIGenerateTextModel,
  openaiGenerateTextResponse,
  openaiStreamChat,
  OPENROUTER_DEFAULT_MODEL,
  openrouterGenerateTextResponse,
  openrouterStreamChat,
  ReasoningEffort,
} from "@maus-inc/voice-ai";
import { secureFetch } from "../utils/secure-fetch.utils";
import { PostProcessingMode } from "../types/ai.types";
import { BaseRepo } from "./base.repo";

export type GenerateTextInput = {
  system?: Nullable<string>;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  /** Honored only by providers and models that accept an effort level. */
  reasoningEffort?: ReasoningEffort;
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

/**
 * True when a cause names the model rather than the account or the network, so
 * choosing a different model could still change the outcome. Mirrors
 * `isGroqModelUnavailableError`, which is what decides this at the provider.
 */
const isModelScopedCause = (cause: unknown): boolean =>
  isGroqModelUnavailableError(cause);

/**
 * The closing sentence of a chain failure.
 *
 * "Choose a different post-processing model in Settings" is only true when at
 * least one cause is model-scoped. On a provider incident returning 503 for
 * both models, no setting can help, so the advice pointed at a control that
 * could not change the result.
 *
 * This text is diagnostic, not user-facing copy. It reaches the desktop log
 * through `recordPostProcessFailure`, and the user sees the classified category
 * beside the fixed failure toast rather than this sentence, so a model id from
 * a provider response is never rendered in the interface.
 */
const describeChainAdvice = (
  primaryCause: unknown,
  fallbackCause: unknown,
): string => {
  if (isModelScopedCause(primaryCause) || isModelScopedCause(fallbackCause)) {
    return "Choose a different post-processing model in Settings.";
  }
  return "Both models failed for a reason another model would not fix. Retry the request.";
};

/**
 * Both models in the Groq fallback chain failed.
 *
 * Reporting only the second error made an unavailable fallback model look
 * exactly like the configured model failing on its own: the log showed a
 * provider 404 naming a model the user never chose, with no sign a second
 * attempt had even run. This names both models and both causes so the next
 * retirement is visible as a chain failure rather than a mystery.
 */
export class GroqGenerateTextFallbackError extends Error {
  readonly primaryModel: GenerateTextModel;
  readonly fallbackModel: GenerateTextModel;
  readonly primaryCause: unknown;
  readonly fallbackCause: unknown;

  constructor({
    primaryModel,
    fallbackModel,
    primaryCause,
    fallbackCause,
  }: {
    primaryModel: GenerateTextModel;
    fallbackModel: GenerateTextModel;
    primaryCause: unknown;
    fallbackCause: unknown;
  }) {
    const describe = (cause: unknown) =>
      cause instanceof Error ? cause.message : String(cause);
    super(
      `Groq post-processing failed on both models. ` +
        `Configured model \`${primaryModel}\` failed: ${describe(primaryCause)}. ` +
        `Fallback model \`${fallbackModel}\` failed: ${describe(fallbackCause)}. ` +
        describeChainAdvice(primaryCause, fallbackCause),
    );
    this.name = "GroqGenerateTextFallbackError";
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.primaryCause = primaryCause;
    this.fallbackCause = fallbackCause;
  }
}

export class GroqGenerateTextRepo extends BaseGenerateTextRepo {
  private groqApiKey: string;
  private model: GenerateTextModel;
  // The default model the constructor falls back to when nothing is stored.
  // It is a live Groq id, so a post-processing failure never becomes a hard
  // 404 the way the retired `qwen/qwen3.6-27b` id did.
  private defaultModel: GenerateTextModel = GROQ_DEFAULT_GENERATE_TEXT_MODEL;

  constructor(apiKey: string, model: string | null) {
    super();
    this.groqApiKey = apiKey;
    // The comment above used to claim this test ran against a widened list that
    // included runtime-discovered models. It never did: `GENERATE_TEXT_MODELS`
    // is the two-id literal, while the picker is populated from the live
    // catalog. So every discovered model the user could pick was silently
    // discarded here and each request went to the default instead.
    //
    // A discovered id is now honoured. An id matching neither the literal list
    // nor the catalog's generative filter still falls back to the default; the
    // filter is a deny-list, so an id that merely avoids its markers would be
    // accepted. Sending an unknown id is recoverable — Groq answers with a model
    // error — whereas pinning every request to the default is not.
    const known =
      model !== null &&
      (GENERATE_TEXT_MODELS as readonly string[]).includes(model);
    this.model =
      model !== null && (known || isGroqGenerativeModelId(model))
        ? (model as GenerateTextModel)
        : this.defaultModel;
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

  private resolveFallbackModel(): GenerateTextModel | undefined {
    // Pick the first supported Groq model that is not the one that just
    // failed. A default-model failure must still reach a second live model, so
    // the fallback is never the same id as the primary.
    //
    // A single-entry catalog resolves to undefined here, and the caller checks
    // for that before spending a second request. Defaulting the miss to
    // `this.defaultModel` would hide the case instead: with one entry in the
    // catalog `find` matches nothing, the default equals the primary, and the
    // guard would re-raise the original failure as if a fallback had run.
    const supported: readonly string[] = GENERATE_TEXT_MODELS;
    return supported.find((candidate) => candidate !== this.model) as
      GenerateTextModel | undefined;
  }

  /**
   * One attempt at one model, reported as a result rather than thrown.
   *
   * The caller decides whether a failure is worth a second model, and that
   * decision depends on the shape of the cause, so the cause has to come back
   * as a value. Returning it also keeps a single catch for the whole chain:
   * two catch blocks in one method, or a `.catch` callback beside a `try`, both
   * read as two names for the same thing and force one of them to be renamed
   * around the other.
   */
  private async attemptModel(
    model: GenerateTextModel,
    input: GenerateTextInput,
  ): Promise<
    | { ok: true; response: GroqGenerateResponseOutput }
    | { ok: false; cause: unknown }
  > {
    try {
      const response = await groqGenerateTextResponse({
        apiKey: this.groqApiKey,
        model,
        prompt: input.prompt,
        system: input.system ?? undefined,
        jsonResponse: input.jsonResponse,
        maxTokens: input.maxTokens,
        reasoningEffort: input.reasoningEffort,
        signal: input.signal,
      });
      return { ok: true, response };
    } catch (error_) {
      return { ok: false, cause: error_ };
    }
  }

  private async generateWithFallback(input: GenerateTextInput) {
    const primary = await this.attemptModel(this.model, input);
    if (primary.ok) return { response: primary.response, model: this.model };

    const primaryCause = primary.cause;

    // An aborted request must never fall back: the abort is the caller's
    // deadline decision, not a provider failure worth another attempt.
    if (input.signal?.aborted) {
      throw primaryCause;
    }

    // An account-scoped rejection (bad key, no credits, permission denied)
    // fails identically on every model, so a second request chain only
    // delays surfacing it.
    if (isGroqAccountScopedError(primaryCause)) {
      throw primaryCause;
    }

    const fallbackModel = this.resolveFallbackModel();
    if (fallbackModel === undefined || fallbackModel === this.model) {
      // No distinct alternative is available, so a second attempt would
      // only repeat the same failure.
      throw primaryCause;
    }

    const fallback = await this.attemptModel(fallbackModel, input);
    if (fallback.ok) {
      return { response: fallback.response, model: fallbackModel };
    }

    // An abort during the second attempt is still the caller's deadline,
    // not a chain failure, so it is not dressed up as one.
    if (input.signal?.aborted) {
      throw fallback.cause;
    }

    throw new GroqGenerateTextFallbackError({
      primaryModel: this.model,
      fallbackModel,
      primaryCause,
      fallbackCause: fallback.cause,
    });
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
  protected customFetch: typeof secureFetch;
  protected abstract readonly inferenceDevice: string;

  constructor(
    url: string,
    model: string,
    apiKey: string,
    customFetch: typeof secureFetch = secureFetch,
  ) {
    super();
    this.baseUrl = url;
    this.model = model;
    this.apiKey = apiKey;
    this.customFetch = customFetch;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      customFetch: this.customFetch,
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
      customFetch: this.customFetch,
    });
  }
}

export class OllamaGenerateTextRepo extends OpenAICompatibleBaseGenerateTextRepo {
  protected readonly inferenceDevice = "API • Ollama";

  constructor(
    url: string,
    model: string,
    apiKey?: string,
    customFetch?: typeof secureFetch,
  ) {
    super(url, model, apiKey || "ollama", customFetch);
  }
}

export class OpenAICompatibleGenerateTextRepo extends OpenAICompatibleBaseGenerateTextRepo {
  protected readonly inferenceDevice = "API • OpenAI Compatible";

  constructor(
    url: string,
    model: string,
    apiKey?: string,
    customFetch?: typeof secureFetch,
  ) {
    super(url, model, apiKey || "", customFetch);
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
    // Default model is GEMINI_GENERATE_TEXT_MODELS[0] (currently gemini-3.8-flash).
    // Previously defaulted to gemini-2.5-flash; bump to 3.8-flash in v3.8
    // release for better latency. Intentional silent upgrade for users without
    // explicit model selection – not a bug.
    this.model =
      (model as GeminiGenerateTextModel) ?? GEMINI_GENERATE_TEXT_MODELS[0];
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
      reasoningEffort: input.reasoningEffort,
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
