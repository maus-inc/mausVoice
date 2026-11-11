import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { retry } from "@maus-inc/utilities";
import Groq from "groq-sdk/index";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import OpenAI, { toFile } from "openai";
import { openaiCompatibleStreamChat } from "./openai.utils";
import {
  buildReasoningEffortParams,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import {
  PROVIDER_MODEL_NOT_FOUND_CODE,
  readProviderCode,
  readProviderStatus,
  redactProviderMessage,
} from "./provider-error.utils";
import { buildGptOssReasoningParams } from "./reasoning.utils";
import type { CustomFetch, DiscoveredModelId, ReasoningEffort } from "./types";
import {
  runSdkTranscription,
  TranscriptionSegment,
  TranscribeAudioOutput,
} from "./transcription.utils";

export const GENERATE_TEXT_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
] as const;
export type GenerateTextModel =
  (typeof GENERATE_TEXT_MODELS)[number] | DiscoveredModelId;

/**
 * Whether a model id discovered from the live Groq catalog can be used for
 * generation.
 *
 * Groq serves transcription, prompt-guard and safeguard models from the same
 * `/models` endpoint, so a catalog fetch returns ids that cannot answer a
 * generation request. This is a deny-list rather than an allow-list on purpose:
 * the catalog changes without notice, and refusing to accept a newly published
 * text model would break post-processing for users the moment Groq ships one.
 *
 * The picker and the post-processing repo must agree on this. When they did not,
 * a model the user had chosen from the catalog was discarded by the repo and
 * every request silently went to the default instead.
 */
export const isGroqGenerativeModelId = (modelId: string): boolean =>
  ![
    // Audio and safety models Groq serves from the same `/models` endpoint.
    "orpheus",
    "whisper",
    // Groq's published guard models are `meta-llama/llama-guard-*`; the
    // older `prompt-guard`/`safeguard` aliases are kept for older ids. Matching
    // on "guard" is what actually covers the current naming — the two aliases
    // alone let a guard model through, and a guard model cannot answer a
    // generation request.
    "guard",
  ].some((marker) => modelId.includes(marker));

/**
 * Model the Groq repo selects when the user has not chosen one. It must stay
 * inside `GENERATE_TEXT_MODELS` so a default-model failure can still fall back
 * to a different live model instead of rethrowing with no second attempt.
 */
export const GROQ_DEFAULT_GENERATE_TEXT_MODEL: (typeof GENERATE_TEXT_MODELS)[number] =
  "openai/gpt-oss-20b";

// Models that support `response_format: { type: "json_schema" }`.
// See https://console.groq.com/docs/structured-outputs
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

/**
 * HTTP statuses that describe the account or the request, not the model.
 * Switching models cannot fix any of them, so neither another retry of the
 * same model nor a second model is worth the extra request chain.
 *
 * 404 is deliberately absent. A 404 from Groq is `model_not_found`, which is
 * exactly the case a different model can fix. 429 is absent because Groq
 * enforces per-model rate limits, so another model can still succeed.
 *
 * 403 is absent for the same reason, and the lookup behind that is recorded
 * because the omission reads as unexamined otherwise. The question was whether
 * a model an organisation is not entitled to comes back as 403, because that
 * case is model-scoped and would then never reach the fallback. Groq's
 * published SDKs are the reachable source of truth for the status-to-meaning
 * mapping: groq-typescript and groq-python both give 403 its own class,
 * `PermissionDeniedError`, with no model-scoped variant, and the only body
 * that carries Groq's per-model wording, "The model `x` does not exist or you
 * do not have access to it.", rides on a 404. The string `model_deaccessed`
 * does not exist in any published Groq artefact. So the access denial this set
 * has to worry about is the 404 above, which already reaches the fallback, and
 * a 403 is an organisation-level refusal that no model in the catalog changes.
 * Keeping 403 here would buy a faster hard failure in exchange for removing the
 * second attempt from the one case where it could help.
 */
const ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES = new Set([400, 401, 402]);

/**
 * True when re-sending the IDENTICAL request cannot succeed, whatever model comes next.
 *
 * Deliberately NOT a member of `ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES`. That set also stops
 * the model-fallback chain, and these two statuses must not stop it -- `groq.utils.test.ts`
 * pins that a 403 reaches the chain, because that is the case the chain exists for. What is
 * pointless for a 403 is re-sending the same request to the same deployment, which is a
 * different decision from which model to try, and it was being made by accident: the
 * argument recorded above concluded a 403 is organisation-level, and nothing carried that
 * conclusion into `isRetryable`.
 *
 * Measured before this: a 403 cost three requests and a 422 cost three, because
 * `retryTerminalStatuses: true` hands every 4xx decision to `isRetryable` and neither
 * status was in either set. 401 correctly cost one.
 *
 *   403  organisation-level refusal. Groq's published SDKs give it its own
 *        `PermissionDeniedError` with no model-scoped variant, and the body carrying
 *        per-model wording rides on a 404, which already reaches the chain.
 *   422  an unprocessable payload. The same bytes are unprocessable next time.
 */
const GROQ_PERMANENT_REQUEST_STATUSES = new Set([403, 422]);

/**
 * True when the failure is scoped to the account or the request rather than
 * the model, so retrying the same model or falling back to a different one
 * cannot succeed.
 */
export const isGroqAccountScopedError = (error: unknown): boolean => {
  const status = readProviderStatus(error);
  return (
    status !== undefined && ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES.has(status)
  );
};

/**
 * Terminal failure for one model id that Groq does not serve. The HTTP status
 * is carried so the caller's account-scoped check keeps working on the
 * normalized error.
 */
export class GroqProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GroqProviderError";
    this.status = status;
  }
}

/**
 * A model id Groq did not serve for this key.
 *
 * This is terminal for that id but deliberately NOT account-scoped: a
 * different model can still answer, which is exactly what the caller's
 * fallback chain exists to do. What must not happen is the provider's raw body
 * being carried forward, because "The model `x` does not exist or you do not
 * have access to it." reads as a verdict the user cannot act on and as a leak
 * of provider internals.
 *
 * The wording stays neutral on purpose. Groq's own body cannot tell a retired
 * id from a model the account is not entitled to, and it reports the access
 * denial on the same 404, so asserting a retirement would misdiagnose a real
 * access failure. The id is named so the chain is diagnosable; the cause is
 * left to the caller to resolve.
 *
 * Scope: this is a diagnostic message, not user-facing copy. It reaches the
 * desktop log through `recordPostProcessFailure`. The user sees one fixed
 * toast and the classified category beside it, never this text, because the
 * chain has no way to guarantee the redaction every provider on the chain
 * applies.
 */
export class GroqModelUnavailableError extends GroqProviderError {
  readonly model: string;

  constructor(model: string, status = 404) {
    super(
      `Groq did not serve the model \`${model}\` for this key. ` +
        "It may be retired, renamed, or not enabled for your account.",
      status,
    );
    this.name = "GroqModelUnavailableError";
    this.model = model;
  }
}

const readErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
};

/**
 * Fallback for SDKs and proxies that flatten the body into the message instead
 * of preserving `error.code`.
 */
const MODEL_NOT_FOUND_MESSAGE =
  /does not exist or you do not have access to it|model[_ ]not[_ ]found/i;

/**
 * True when Groq rejected the model id itself. A retired model cannot come
 * back, so this is not retried; it is also not account-scoped, so the caller
 * still gets to try a different model before reporting failure.
 */
export const isGroqPermanentRequestError = (error: unknown): boolean => {
  const status = readProviderStatus(error);
  return status !== undefined && GROQ_PERMANENT_REQUEST_STATUSES.has(status);
};

export const isGroqModelUnavailableError = (error: unknown): boolean => {
  if (error instanceof GroqModelUnavailableError) return true;
  if (readProviderStatus(error) !== 404) return false;

  return readProviderCode(error) === PROVIDER_MODEL_NOT_FOUND_CODE
    ? true
    : MODEL_NOT_FOUND_MESSAGE.test(readErrorMessage(error));
};

/**
 * Replace literal API key and authorization material anywhere in a provider
 * message.
 *
 * This is a named alias of the shared scrubber, not a second implementation.
 * The shared pattern list is one combined alternation over `gsk`, `csk` and
 * `sk` followed by `-` or `_`, so it already covers every prefix Groq, Cerebras
 * and the OpenAI-compatible providers issue, plus the `Bearer`, `Authorization`
 * and `api_key` forms a proxy can echo. A provider that needs a prefix nobody
 * issues adds it at the one shared list rather than in a second file, which is
 * the drift this alias exists to prevent. Without it a 401 that echoes the
 * supplied key would put the key into logs and into persisted
 * `postProcessError` metadata.
 */
export const redactGroqMessage = redactProviderMessage;

/**
 * A Groq error that names no model-scoped cause. Covers a string throw, a
 * throw of an object without a message, and a bare status with no body.
 *
 * The status suffix is appended by an early return rather than inside the
 * caller's conditional, so no expression here both tests a condition and
 * builds a message from it. The thrown value is stringified rather than
 * discarded: `normalizeCerebrasError` keeps `String(error)` for the same case,
 * and a string throw used to degrade to a bare "request failed with status N"
 * that threw the real cause away.
 */
const readNonErrorMessage = (
  error: unknown,
  status: number | undefined,
): string => {
  const text = redactGroqMessage(String(error));
  if (status === undefined) return text;
  return `${text} with status ${status}`;
};

/**
 * The error shape a cancelled request takes, decided from the value itself
 * rather than from the state of the caller's `AbortSignal`.
 *
 * `retry` sleeps between attempts and re-checks `isRetryable` after the sleep,
 * and that predicate reads `signal.aborted`. A deadline that fires during the
 * sleep makes `retry` rethrow the *original* provider failure, so a signal-only
 * test cannot tell that failure apart from a real abort and would pass it
 * through unredacted. A cancelled fetch is instead identifiable by shape: the
 * DOM abort error (`name === "AbortError"`, and `code === 20` at the fetch
 * layer) or the SDK's own `APIUserAbortError`.
 */
const isAbortErrorShape = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "AbortError" || name === "APIUserAbortError" || code === 20;
};

/**
 * Normalize anything a Groq call throws into an error safe to show and store:
 * a model Groq did not serve becomes a `GroqModelUnavailableError` naming the
 * id, and key material is scrubbed from everything else. Transient failures
 * stay retryable because the status is preserved.
 */
export const normalizeGroqError = (error: unknown, model: string): Error => {
  if (error instanceof GroqModelUnavailableError) return error;

  if (isGroqModelUnavailableError(error)) {
    return new GroqModelUnavailableError(model);
  }

  const status = readProviderStatus(error);
  const rawMessage =
    error instanceof Error && error.message
      ? error.message
      : readNonErrorMessage(error, status);

  return new GroqProviderError(
    `Groq: ${redactGroqMessage(rawMessage)}`,
    status,
  );
};

export const TRANSCRIPTION_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new Groq({
    apiKey: apiKey.trim(),
    // Runs inside a Tauri WebView where the SDK's browser check would
    // otherwise reject; the key is never persisted and the request goes
    // through the desktop's secure-fetch bridge when customFetch is set.
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

export type GroqTranscriptionArgs = {
  apiKey: string;
  model?: TranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
  customFetch?: CustomFetch;
};

export type GroqTranscriptionSegment = TranscriptionSegment;
export type GroqTranscribeAudioOutput = TranscribeAudioOutput;

export const groqTranscribeAudio = async ({
  apiKey,
  model = "whisper-large-v3-turbo",
  blob,
  ext,
  prompt,
  language,
  customFetch,
}: GroqTranscriptionArgs): Promise<GroqTranscribeAudioOutput> => {
  const client = createClient(apiKey, customFetch);
  const file = await toFile(blob, `audio.${ext}`);
  return runSdkTranscription(
    (body) =>
      client.audio.transcriptions.create(
        body as unknown as Parameters<
          typeof client.audio.transcriptions.create
        >[0],
      ),
    {
      file,
      model,
      prompt,
      language,
      response_format: "verbose_json",
    },
  );
};

export type GroqGenerateTextArgs = {
  apiKey: string;
  model?: GenerateTextModel;
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  customFetch?: CustomFetch;
};

export type GroqGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const groqGenerateTextResponse = async ({
  apiKey,
  model = "openai/gpt-oss-20b",
  system,
  prompt,
  imageUrls = [],
  jsonResponse,
  maxTokens,
  reasoningEffort,
  signal,
  customFetch,
}: GroqGenerateTextArgs): Promise<GroqGenerateResponseOutput> => {
  return retry({
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures. Only an actually aborted signal is
    // terminal. An account-scoped rejection is terminal too: another attempt
    // on the same key cannot succeed. So is a retired model id: it cannot come
    // back, so retrying it only spends the caller's deadline before the
    // fallback chain gets its turn.
    //
    // The helper treats a 4xx as terminal before it consults `isRetryable`, and
    // that default is wrong here: Groq serves no documented code for a
    // model-scoped 403, so a denial the fallback model can still answer is
    // exactly the case the chain exists for. Opting out of the blanket 4xx
    // rejection hands the whole decision back to `isRetryable` above, which
    // already refuses the statuses that genuinely cannot clear: 400/401/402
    // account-scoped, a model id Groq does not serve, and -- since `isGroqPermanentRequestError`
    // -- a 403 or 422, which are permanent for this request without being reasons to give up
    // on the model chain. That comment was wrong about its own predicate until this commit:
    // neither status was in any set, so both cost three requests.
    retryTerminalStatuses: true,
    retries: 3,
    isRetryable: (error) =>
      !signal?.aborted &&
      !isGroqAccountScopedError(error) &&
      !isGroqPermanentRequestError(error) &&
      !isGroqModelUnavailableError(error),
    // An abort during the wait is honoured: `retry` hands the signal to its
    // own wait, so a cancelled caller stops there instead of sitting it out.
    signal,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const messages: ChatCompletionMessageParam[] = [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        {
          role: "user" as const,
          content: [
            ...imageUrls.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
            { type: "text" as const, text: prompt },
          ],
        },
      ];

      const response = await client.chat.completions.create(
        {
          messages,
          model,
          // GPT-OSS defaults to medium reasoning effort and charges those
          // tokens to the completion budget; reasoning.utils holds the
          // model-gated controls.
          ...buildGptOssReasoningParams(model),
          max_completion_tokens: maxTokens ?? 5000,
          ...buildReasoningEffortParams(model, reasoningEffort),
          response_format: jsonResponse
            ? JSON_SCHEMA_SUPPORTED_MODELS.has(model)
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: jsonResponse.name,
                    description: jsonResponse.description,
                    // Strict mode switches Groq to constrained decoding, so a
                    // cleanup reply can never be syntactically valid JSON that
                    // violates the schema. Groq documents it as the production
                    // setting and supports it on these models.
                    strict: true,
                    schema: jsonResponse.schema,
                  },
                }
              : { type: "json_object" }
            : undefined,
        },
        { signal },
      );

      console.log("groq llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "Groq",
      });
    },
  }).catch((error: unknown) => {
    // A cancelled request is passed through untouched so callers can still
    // recognize it as an abort. It is identified by shape, not by
    // `signal.aborted`: a deadline that fires during the retry sleep makes
    // `retry` rethrow the original provider failure, and testing the signal
    // would mistake that failure for an abort and skip redaction, putting a
    // provider body that echoes the key into the log verbatim.
    if (isAbortErrorShape(error)) throw error;
    // A cancel that lands during the wait between attempts arrives as the
    // caller's own reason, because `retry` rethrows `signal.reason` verbatim.
    // That value must reach the caller unchanged or a cancelled dictation looks
    // like a provider fault. Identity is the only safe test for it: reading
    // `signal.aborted` alone would also pass a real provider failure that
    // happened to be in flight when the caller cancelled, and that one carries
    // a body which can echo the key into the log unredacted.
    if (signal?.aborted && signal.reason === error) throw error;
    throw normalizeGroqError(error, model);
  });
};

export type GroqTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const groqTestIntegration = async ({
  apiKey,
  customFetch,
}: GroqTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type GroqStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* groqStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: GroqStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: "https://api.groq.com/openai/v1",
    // Same WebView constraint as createClient above; requests are routed
    // through the desktop secure-fetch bridge when customFetch is set.
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
    // The SDK's own retry layer is OFF. `retry()` below is this package's single retry
    // layer, and it carries the parts the SDK's does not: `isRetryable`, a wait the caller's
    // abort signal can cut short, and `Retry-After` as far as the header parser allows. With
    // both layers live the attempts multiply -- measured, one failed call issued 9 requests
    // for a 500 -- and each of those is a chargeable request.
    maxRetries: 0,
  });
  yield* openaiCompatibleStreamChat(client, model, input);
}
