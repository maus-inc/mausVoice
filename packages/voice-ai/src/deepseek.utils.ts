import OpenAI from "openai";
import { retry } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
import {
  buildJsonObjectPrompt,
  buildOpenAICompatibleMessages,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import type { CustomFetch, DiscoveredModelId } from "./types";

// Current hosted IDs from https://api-docs.deepseek.com/quick_start/pricing/.
// The legacy deepseek-chat/deepseek-reasoner aliases were retired in July 2026.
export const DEEPSEEK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;
export type DeepseekModel =
  (typeof DEEPSEEK_MODELS)[number] | DiscoveredModelId;

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: DEEPSEEK_BASE_URL,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
    // The SDK's own retry layer is OFF. `retry()` below is this package's single retry
    // layer, and it carries the parts the SDK's does not: `isRetryable`, a wait the caller's
    // abort signal can cut short, and `Retry-After` as far as the header parser allows. With
    // both layers live the attempts multiply -- measured, one failed call issued 9 requests
    // for a 500 -- and each of those is a chargeable request.
    maxRetries: 0,
  });
};

export type DeepseekGenerateTextArgs = {
  apiKey: string;
  model?: DeepseekModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
};

export type DeepseekGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const deepseekGenerateTextResponse = ({
  apiKey,
  model = DEEPSEEK_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
  signal,
}: DeepseekGenerateTextArgs): Promise<DeepseekGenerateResponseOutput> => {
  return retry({
    // An aborted request must not be retried; the abort is the caller's
    // deadline decision, not a transient failure worth another attempt.
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures.
    retries: 3,
    isRetryable: () => !signal?.aborted,
    // An abort during the wait is honoured: `retry` hands the signal to its
    // own wait, so a cancelled caller stops there instead of sitting it out.
    // The SDK's own retry layer is off -- `maxRetries: 0` at the client -- so its
    // `APIError` reaches `retry` on the FIRST attempt. That is what makes the wait below the
    // only wait. Before that setting the SDK retried three times underneath, honouring
    // `Retry-After` on the way, so the caller sat through three of its own waits before this
    // one began and a single call issued nine requests.
    // That wait is the helper's own 20ms, because the helper only stretches
    // a wait for a `Retry-After` hint and reads that hint off an `HttpError`.
    // DeepSeek is called through the OpenAI SDK, whose own `APIError` nothing
    // here converts, so a 429 is retried 20ms later. Converting the failure
    // with `toHttpError` inside `fn` (the pattern in `transcription.utils.ts`)
    // is what would let a hint apply here, capped at the helper's 2s default.
    signal,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const finalPrompt = buildJsonObjectPrompt({ prompt, jsonResponse });
      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
      });

      const response = await client.chat.completions.create(
        {
          messages,
          model,
          temperature: 1,
          max_tokens: maxTokens ?? 1024,
          top_p: 1,
          response_format: jsonResponse ? { type: "json_object" } : undefined,
        },
        { signal },
      );

      console.log("deepseek llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "DeepSeek",
      });
    },
  });
};

export type DeepseekTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const deepseekTestIntegration = async ({
  apiKey,
  customFetch,
}: DeepseekTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type DeepseekStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* deepseekStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: DeepseekStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  yield* openaiCompatibleStreamChat(client, model, input);
}
