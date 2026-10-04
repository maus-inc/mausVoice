import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import {
  buildJsonSchemaResponseFormat,
  OPENAI_LEGACY_CHAT_MODELS,
} from "./response-format.utils";
import { buildJsonObjectPrompt } from "./openai-compatible-generate.utils";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import {
  isOpenAIOReasoningModel,
  openaiCompatibleStreamChat,
} from "./openai.utils";
import type { CustomFetch } from "./types";

export const AZURE_OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4",
  "gpt-35-turbo",
] as const;
export type AzureOpenAIModel = (typeof AZURE_OPENAI_MODELS)[number];

// Azure OpenAI deployment names mirror the upstream model naming (minus
// the version dot for 3.5: "gpt-35-turbo"). Only the pre-Structured-Outputs
// legacy chat deployments reject `json_schema` and must receive the
// legacy `json_object` shape; every other deployment — including
// user-deployed open-source models (Llama, Phi, etc.) — defaults to
// `json_schema`, matching upstream behavior.
//
// Derive the legacy set from the canonical OpenAI list so the two cannot
// drift apart (the original hand-maintained copy missed the "-preview"
// snapshot names and silently sent json_schema to frozen previews).
const AZURE_JSON_OBJECT_ONLY_MODELS = new Set<string>(
  OPENAI_LEGACY_CHAT_MODELS.flatMap((model) =>
    model.startsWith("gpt-3.5-turbo")
      ? [model, model.replace("gpt-3.5-turbo", "gpt-35-turbo")]
      : [model],
  ),
);
// Azure users also name deployments after the frozen snapshots without the
// "-preview" suffix; those are the same legacy models and get the legacy
// shape too.
AZURE_JSON_OBJECT_ONLY_MODELS.add("gpt-4-1106");
AZURE_JSON_OBJECT_ONLY_MODELS.add("gpt-4-0125");

// Azure serves open-weight models (Llama, Phi, Mistral, ...) through JSON
// mode (`json_object`) and rejects `json_schema` for them, so those
// deployment families also take the legacy shape.
const OPEN_MODEL_DEPLOYMENT_PREFIXES = [
  "llama",
  "phi",
  "mistral",
  "mixtral",
] as const;

export const isAzureJsonObjectOnlyModel = (deploymentName: string): boolean => {
  // Deployment names are user-chosen aliases, so a deployment named
  // "GPT-4-TURBO" is the same legacy model as "gpt-4-turbo": match the set
  // case-insensitively (all canonical names are lowercase).
  const name = deploymentName.toLowerCase();
  return (
    AZURE_JSON_OBJECT_ONLY_MODELS.has(name) ||
    OPEN_MODEL_DEPLOYMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
};

export type AzureOpenAIGenerateTextArgs = {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
};

const buildResponseFormat = (
  deploymentName: string,
  jsonResponse?: JsonResponse,
) =>
  buildJsonSchemaResponseFormat(
    deploymentName,
    isAzureJsonObjectOnlyModel,
    jsonResponse,
  );

export type AzureOpenAIGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

const createClient = (
  apiKey: string,
  endpoint: string,
  customFetch?: CustomFetch,
) => {
  return new AzureOpenAI({
    apiKey: apiKey.trim(),
    endpoint: endpoint.trim(),
    apiVersion: "2024-10-21",
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
    // The SDK's own retry layer is OFF. `retry()` is this package's single retry layer, and
    // it carries the parts the SDK's does not: `isRetryable`, a wait the caller's abort
    // signal can cut short, and `Retry-After` as far as the header parser allows. With both
    // layers live the attempts multiply -- measured, one failed call issued 9 requests for a
    // 500 -- and each of those is a chargeable request.
    maxRetries: 0,
  });
};

export const azureOpenAIGenerateText = ({
  apiKey,
  endpoint,
  deploymentName,
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
  signal,
}: AzureOpenAIGenerateTextArgs): Promise<AzureOpenAIGenerateResponseOutput> => {
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
    // Azure is called through the OpenAI SDK, whose own `APIError` nothing
    // here converts, so a 429 is retried 20ms later. Converting the failure
    // with `toHttpError` inside `fn` (the pattern in `transcription.utils.ts`)
    // is what would let a hint apply here, capped at the helper's 2s default.
    signal,
    fn: async () => {
      const client = createClient(apiKey, endpoint, customFetch);

      // The `json_object` shape (legacy deployments only) requires the word
      // "JSON" somewhere in the context or the API rejects the request;
      // append the schema instruction only on that branch so json_schema
      // calls are unchanged.
      const finalPrompt =
        jsonResponse && isAzureJsonObjectOnlyModel(deploymentName)
          ? buildJsonObjectPrompt({ prompt, jsonResponse })
          : prompt;

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: finalPrompt });

      const response_format = buildResponseFormat(deploymentName, jsonResponse);

      // An o-series deployment rejects `temperature` outright, which is an HTTP
      // 400 before any tokens are generated -- so a user who picked a reasoning
      // model got no dictation and no explanation.
      const params = {
        messages,
        model: deploymentName,
        max_completion_tokens: maxTokens ?? 1024,
        response_format,
        ...(isOpenAIOReasoningModel(deploymentName) ? {} : { temperature: 1 }),
      };

      const response = await client.chat.completions.create(params, { signal });

      const content = response.choices?.[0]?.message?.content || "";
      return {
        text: content,
        tokensUsed: response.usage?.total_tokens ?? countWords(content),
      };
    },
  });
};

export type AzureOpenAITestIntegrationArgs = {
  apiKey: string;
  endpoint: string;
  customFetch?: CustomFetch;
};

export const azureOpenAITestIntegration = async ({
  apiKey,
  endpoint,
  customFetch,
}: AzureOpenAITestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, endpoint, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type AzureOpenAIStreamChatArgs = {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* azureOpenaiStreamChat({
  apiKey,
  endpoint,
  deploymentName,
  input,
  customFetch,
}: AzureOpenAIStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, endpoint, customFetch);
  yield* openaiCompatibleStreamChat(client, deploymentName, input);
}
