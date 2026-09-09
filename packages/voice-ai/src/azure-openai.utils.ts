import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import { buildJsonSchemaResponseFormat } from "./response-format.utils";
import { buildJsonObjectPrompt } from "./openai-compatible-generate.utils";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
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

// Azure OpenAI deployments mirror the upstream model naming (minus the
// version dot for 3.5: "gpt-35-turbo"). Only the pre-Structured-Outputs
// legacy chat deployments reject `json_schema` and must receive the
// legacy `json_object` shape; every other deployment — including
// user-deployed open-source models (Llama, Phi, etc.) — defaults to
// `json_schema`, matching upstream behavior.
const JSON_OBJECT_ONLY_MODELS = new Set<string>([
  "gpt-35-turbo",
  "gpt-35-turbo-16k",
  "gpt-35-turbo-0125",
  "gpt-35-turbo-1106",
  "gpt-4",
  "gpt-4-0301",
  "gpt-4-0613",
  "gpt-4-32k",
  "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-1106",
  "gpt-4-0125",
]);

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
  const name = deploymentName.toLowerCase();
  return (
    JSON_OBJECT_ONLY_MODELS.has(deploymentName) ||
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
) => buildJsonSchemaResponseFormat(deploymentName, isAzureJsonObjectOnlyModel, jsonResponse);

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
  });
};

export const azureOpenAIGenerateText = async ({
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
    isRetryable: (error) => !signal?.aborted,
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

      const response = await client.chat.completions.create(
        {
          messages,
          model: deploymentName,
          temperature: 1,
          max_completion_tokens: maxTokens ?? 1024,
          response_format,
        },
        { signal },
      );

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
