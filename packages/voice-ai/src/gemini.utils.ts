import {
  retry,
  countWords,
  parseJsonObject,
  HttpError,
} from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
  LlmToolChoice,
} from "@maus-inc/types";
import type { CustomFetch, DiscoveredModelId } from "./types";
import { buildGeminiThinkingConfig } from "./reasoning.utils";

export const GEMINI_GENERATE_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-2.5-flash",
] as const;
export type GeminiGenerateTextModel =
  (typeof GEMINI_GENERATE_TEXT_MODELS)[number] | DiscoveredModelId;

export const GEMINI_TRANSCRIPTION_MODELS = [
  "gemini-3.5-transcribe",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
] as const;
export type GeminiTranscriptionModel =
  (typeof GEMINI_TRANSCRIPTION_MODELS)[number] | DiscoveredModelId;

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_URL =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";

type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type GeminiPart = {
  text?: string;
  audioTranscription?: { text: string };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = {
  role?: "user" | "model";
  parts: GeminiPart[];
};

type GeminiFunctionCallingConfig = {
  /** `ANY` is Gemini's "must call a tool", `NONE` its "must not". */
  mode: "AUTO" | "ANY" | "NONE";
  /** Restricts `ANY` to named functions. */
  allowedFunctionNames?: string[];
};

type GeminiToolConfig = {
  functionCallingConfig: GeminiFunctionCallingConfig;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

type GeminiGenerateContentRequest = {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  toolConfig?: GeminiToolConfig;
  generationConfig?: Record<string, unknown>;
};

// Model ids come from Google's discovery endpoint or a stored preference and
// interpolate into the request path. Dot segments would rewrite the path on
// the same host (`navigator` join semantics), and a re-split then re-encoded
// slash is a silent path break — validate the charset and reject instead.
const GEMINI_MODEL_ID = /^[A-Za-z0-9._-]+$/;

const geminiModelPath = (model: string): string => {
  const candidate = model.replace(/^models\//, "");
  if (!GEMINI_MODEL_ID.test(candidate)) {
    throw new TypeError(
      `Gemini invalid model id: ${JSON.stringify(model.slice(0, 128))} — expected letters, digits, dot, underscore, dash (from the provider's model list).`,
    );
  }
  return encodeURIComponent(candidate);
};

/**
 * The upload reached a terminal FAILED state.
 *
 * Its own type so `pollGeminiFileState` can tell it apart from a transient
 * endpoint failure. Without that distinction FAILED was caught by the
 * "anything else is the endpoint being briefly unavailable" branch and polled
 * through until the attempts ran out, so a file the provider had already given
 * up on was retried for the whole budget before reporting a generic timeout.
 */
class GeminiFileProcessingError extends Error {
  constructor() {
    super("Gemini file processing failed");
    this.name = "GeminiFileProcessingError";
  }
}

/**
 * Non-2xx Gemini response with the HTTP status preserved, so retry helpers
 * can distinguish a permanent client error (400/401/403/404) from a transient
 * rate limit or server failure. Extends the shared `HttpError` so every
 * provider in this package reports failures with the same shape.
 */
class GeminiHttpError extends HttpError {
  constructor(status: number, detail: string, retryAfter?: string | null) {
    super(
      status,
      detail
        ? `Gemini responded ${status}: ${detail}`
        : `Gemini responded with status ${status}`,
      { retryAfter },
    );
    this.name = "GeminiHttpError";
  }
}

// Permanent 4xx failures (bad key, malformed request, unknown model) are never
// fixed by resending the same payload; retrying them rebuilds and re-uploads
// the whole audio body for nothing. Abort/cancel must also stop retrying —
// including the deadline path: AbortSignal.timeout rejects with a
// "TimeoutError"-named reason, not "AbortError".
const isGeminiFailureRetryable = (
  error: unknown,
  signal?: AbortSignal,
): boolean => {
  if (signal?.aborted) {
    return false;
  }
  if (error instanceof GeminiHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return false;
  }
  const cause = (error as { cause?: unknown })?.cause;
  if (
    error instanceof Error &&
    (error.message.toLowerCase().includes("aborted") ||
      (cause instanceof Error &&
        (cause.name === "AbortError" ||
          cause.message.toLowerCase().includes("aborted"))))
  ) {
    return false;
  }
  return true;
};

// Non-streaming calls get a generous absolute deadline — one signal minted
// per operation and shared by every retry attempt (upload + transcribe of a
// long clip can legitimately take minutes, but a stalled connection must not
// hang post-processing forever). Streaming calls use the caller's signal
// directly — a fixed total timeout would kill healthy long-running
// generations mid-stream.
const GEMINI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const withDeadlineSignal = (
  signal: AbortSignal | undefined,
): AbortSignal | undefined =>
  typeof AbortSignal.timeout === "function" &&
  typeof AbortSignal.any === "function"
    ? AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
      ])
    : signal;

const requestGemini = async (
  apiKey: string,
  model: string,
  action: "generateContent" | "streamGenerateContent",
  body: GeminiGenerateContentRequest,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<Response> => {
  const suffix = action === "streamGenerateContent" ? "?alt=sse" : "";
  const response = await customFetch(
    `${GEMINI_API_URL}/models/${geminiModelPath(model)}:${action}${suffix}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey.trim(),
      },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GeminiHttpError(
      response.status,
      detail,
      response.headers.get("retry-after"),
    );
  }

  return response;
};

const getGeminiResponseText = (
  response: GeminiGenerateContentResponse,
): string =>
  (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

const getGeminiTranscriptionText = (
  response: GeminiGenerateContentResponse,
): string => {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const hasAudioTranscription = parts.some((part) => part.audioTranscription);

  // Gemini places diarized speaker segments in separate parts. Keep a word
  // boundary when flattening those segments, and prefer non-empty part text.
  const text = hasAudioTranscription
    ? parts
        .map((part) => {
          const partText = typeof part.text === "string" ? part.text : "";
          if (partText.trim()) return partText;
          const transcriptionText = part.audioTranscription?.text;
          return typeof transcriptionText === "string" ? transcriptionText : "";
        })
        .map((partText) => partText.trim())
        .filter(Boolean)
        .join(" ")
    : getGeminiResponseText(response);

  if (!text.trim()) throw new Error("Transcription failed - empty response");
  return text;
};

const GEMINI_SCHEMA_TYPE_MAP: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
  null: "NULL",
};

type JsonSchemaConverter = (
  schema: Record<string, unknown>,
) => Record<string, unknown>;

type JsonSchemaTypeConversion =
  | { kind: "single"; type: unknown; nullable?: true }
  | { kind: "union"; types: string[] };

const isJsonSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const convertJsonSchemaTypeName = (type: string): string => {
  const mappedType = GEMINI_SCHEMA_TYPE_MAP[type];
  return typeof mappedType === "string" ? mappedType : type;
};

const normalizeJsonSchemaTypeArray = (types: unknown[]): string[] => {
  if (types.length === 0) {
    throw new TypeError("Gemini JSON Schema type unions cannot be empty");
  }
  return [
    ...new Set(
      types.map((type) => {
        if (typeof type !== "string") {
          throw new TypeError(
            "Gemini JSON Schema type unions must contain only strings",
          );
        }
        return type === "NULL" ? "null" : type;
      }),
    ),
  ];
};

const convertJsonSchemaTypeUnion = (
  types: string[],
): JsonSchemaTypeConversion => {
  const valueTypes = types.filter((type) => type !== "null");
  const valueType = valueTypes[0];
  if (valueType === undefined) return { kind: "single", type: "NULL" };
  if (valueTypes.length > 1) return { kind: "union", types };
  return {
    kind: "single",
    type: convertJsonSchemaTypeName(valueType),
    ...(types.includes("null") ? { nullable: true } : {}),
  };
};

const convertJsonSchemaType = (value: unknown): JsonSchemaTypeConversion => {
  if (typeof value === "string") {
    return { kind: "single", type: convertJsonSchemaTypeName(value) };
  }
  if (!Array.isArray(value)) return { kind: "single", type: value };
  return convertJsonSchemaTypeUnion(normalizeJsonSchemaTypeArray(value));
};

const applyJsonSchemaType = (
  schema: Record<string, unknown>,
  conversion: JsonSchemaTypeConversion,
): void => {
  if (conversion.kind === "single") {
    schema.type = conversion.type;
    if (conversion.nullable) schema.nullable = true;
    return;
  }

  const existingAnyOf = schema.anyOf;
  const typeSchemas = conversion.types.map((type) => ({
    type: convertJsonSchemaTypeName(type),
  }));
  if (existingAnyOf === undefined) {
    schema.anyOf = typeSchemas;
    return;
  }
  if (!Array.isArray(existingAnyOf)) {
    throw new TypeError("Gemini JSON Schema anyOf must be an array");
  }
  schema.anyOf = typeSchemas.map((typeSchema) => ({
    ...typeSchema,
    anyOf: existingAnyOf,
  }));
};

const convertJsonSchemaArrayItem = (
  item: unknown,
  convertSchema: JsonSchemaConverter,
): unknown => (isJsonSchemaObject(item) ? convertSchema(item) : item);

const convertJsonSchemaValue = (
  value: unknown,
  convertSchema: JsonSchemaConverter,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => convertJsonSchemaArrayItem(item, convertSchema));
  }
  return convertJsonSchemaArrayItem(value, convertSchema);
};

const convertJsonSchemaProperties = (
  value: unknown,
  convertSchema: JsonSchemaConverter,
): unknown => {
  if (!isJsonSchemaObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, schema]) => [
      name,
      convertJsonSchemaArrayItem(schema, convertSchema),
    ]),
  );
};

const convertJsonSchemaEntry = (
  key: string,
  value: unknown,
  convertSchema: JsonSchemaConverter,
): unknown => {
  switch (key) {
    case "properties":
      return convertJsonSchemaProperties(value, convertSchema);
    case "items":
    case "anyOf":
      return convertJsonSchemaValue(value, convertSchema);
    default:
      return value;
  }
};

const convertJsonSchemaToGeminiSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isJsonSchemaObject(schema)) return schema;

  const converted: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "type")
      .map(([key, value]) => [
        key,
        convertJsonSchemaEntry(key, value, convertJsonSchemaToGeminiSchema),
      ]),
  );
  if (Object.hasOwn(schema, "type")) {
    applyJsonSchemaType(converted, convertJsonSchemaType(schema.type));
  }
  return converted;
};

export const isGeminiTranscribeModel = (model: string): boolean =>
  model.includes("-transcribe") && !model.includes("-live");

/**
 * The extension that goes into the uploaded file's `display_name`. Gemini stores
 * the container from the `mimeType` the request declares, not from this label, so
 * an unrecognised type is labelled wav purely to keep the name readable.
 */
const uploadExtension = (mimeType: string): string => {
  if (mimeType.includes("mp3")) {
    return "mp3";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  return "wav";
};

const arrayBufferToBase64 = (
  buffer: ArrayBuffer | Uint8Array | Buffer,
): string => {
  // A Buffer is a Uint8Array, so a sliced Buffer passes through untouched and
  // keeps its offset and length rather than being copied into a fresh
  // allocation.
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64");
  }
  // Browser path: build binary string in chunks to avoid O(n²) concatenation
  // and stack overflow. Each chunk is converted via manual loop using
  // fromCodePoint (Sonar prefers it over fromCharCode) and joined.
  const chunkSize = 0x8000;
  const binaryChunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binary = "";
    for (const byte of chunk) {
      binary += String.fromCodePoint(byte);
    }
    binaryChunks.push(binary);
  }
  return btoa(binaryChunks.join(""));
};

const normalizeGeminiLanguageCode = (lang: string): string => {
  const trimmed = lang.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("-")) return trimmed;
  const lower = trimmed.toLowerCase();
  const map: Record<string, string> = {
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    de: "de-DE",
    it: "it-IT",
    ja: "ja-JP",
    ko: "ko-KR",
    pt: "pt-BR",
    zh: "cmn-Hans-CN",
    nl: "nl-NL",
    pl: "pl-PL",
    ru: "ru-RU",
    tr: "tr-TR",
    hi: "hi-IN",
    ar: "ar-EG",
  };
  return map[lower] ?? trimmed;
};

const ensureOk = async (response: Response): Promise<void> => {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GeminiHttpError(response.status, detail);
  }
};

/**
 * Hosts the Files API is allowed to hand us a URL for.
 *
 * In production, only googleapis.com and storage.googleapis.com are expected.
 * `upload.example.com` is allowed for tests.
 */
const GEMINI_ALLOWED_HOSTS = [
  "generativelanguage.googleapis.com",
  "storage.googleapis.com",
  "upload.example.com",
];

const isAllowedGeminiHost = (hostname: string): boolean =>
  GEMINI_ALLOWED_HOSTS.some(
    (host) => hostname === host || hostname.endsWith("." + host),
  );

/**
 * Reject a URL the Files API pointed us at.
 *
 * `strict` is for the URLs we attach the API key to. The upload URL is not one
 * of them -- it is a signed resumable-upload target and carries no credential --
 * so an unexpected host there is logged and allowed through for
 * forward-compatibility, with the scheme still enforced.
 */
const assertGeminiUrl = (url: string, strict: boolean): void => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS Gemini URL: ${parsed.protocol}`);
  }
  if (!isAllowedGeminiHost(parsed.hostname)) {
    if (strict) {
      throw new Error(
        `Refusing to send the Gemini API key to unexpected host ${parsed.hostname}`,
      );
    }
    // Warn rather than refuse, because the upload URL is whatever Google put in
    // `x-goog-upload-url` and refusing would break dictation the day they add a
    // host. The control that actually stops the key reaching an unexpected host
    // is NOT here and NOT `secureFetch`: it is the Tauri `http:default`
    // capability's host allow-list, which blocks the request before it leaves the
    // process. That allow-list is itself pinned by
    // `apps/desktop/src/__tests__/csp-capability.contract.test.ts`, so this hedge
    // rests on a checked fact rather than on a claim -- if `*.googleapis.com`
    // were ever dropped from the capability, that test fails and this reasoning
    // has to be revisited rather than inherited.
    console.warn(`Gemini Files API: unexpected upload host ${parsed.hostname}`);
  }
};

const getUploadUrl = (response: Response): string => {
  const url =
    response.headers.get("x-goog-upload-url") ??
    response.headers.get("X-Goog-Upload-URL");
  if (!url) {
    console.warn(
      "Gemini Files API: missing x-goog-upload-url header – falling back to inlineData",
    );
    throw new Error("Gemini Files API did not return an upload URL");
  }
  try {
    assertGeminiUrl(url, false);
  } catch (e) {
    if (e instanceof Error && e.message.includes("Refusing")) throw e;
    // If URL parsing fails, treat as invalid and fallback.
    throw new Error(`Invalid upload URL: ${url.slice(0, 128)}`);
  }
  return url;
};

const uploadGeminiFile = async (
  apiKey: string,
  blob: ArrayBuffer | Buffer,
  mimeType: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<{ uri: string; mimeType: string }> => {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);

  const startResponse = await customFetch(GEMINI_UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey.trim(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({
      file: {
        display_name: `mausvoice-${Date.now()}.${uploadExtension(mimeType)}`,
      },
    }),
    signal,
  });
  await ensureOk(startResponse);
  const uploadUrl = getUploadUrl(startResponse);

  const uploadResponse = await customFetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes as unknown as BodyInit,
    signal,
  });
  await ensureOk(uploadResponse);

  const payload = (await uploadResponse.json()) as {
    file?: { uri?: string; mimeType?: string; mime_type?: string };
  };
  const uri = payload.file?.uri;
  if (!uri)
    throw new Error(
      "Gemini Files API upload succeeded but returned no file URI",
    );
  // This one is checked, and hard-blocked, because both consumers below attach
  // `x-goog-api-key` to it: `deleteGeminiFile` and `fetchGeminiFileState` each
  // send the Gemini credential to whatever host this string names. The upload
  // URL gets the same check but only warns, because that request carries no key.
  // A URI that is not a Gemini host is a failed upload, not a reason to post the
  // user's credential somewhere else.
  assertGeminiUrl(uri, true);
  return {
    uri,
    mimeType: payload.file?.mimeType ?? payload.file?.mime_type ?? mimeType,
  };
};

/**
 * Remove an uploaded file from the Files API, best effort.
 *
 * The signal is threaded in because this runs in a `finally` and on the fallback
 * path, which is where a cancellation has already been spent on the request
 * that preceded it. Without one, a stalled deletion kept the transcription
 * awaiting a response that was never coming, with nothing left to release it:
 * the five-minute operation deadline expires, `deleteGeminiFile` is still
 * awaiting, and the caller waits forever. Every other request on this path
 * carries the signal for the same reason.
 *
 * A failed or abandoned cleanup is only logged. It is a leaked provider-side
 * file, and turning that into a failed dictation the user has to see would be a
 * worse outcome than the leak.
 */
const deleteGeminiFile = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<void> => {
  try {
    await customFetch(fileUri, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey.trim() },
      signal,
    });
  } catch (error) {
    console.warn(
      `Gemini Files API cleanup failed for ${fileUri.slice(0, 80)}: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
    );
  }
};

const fetchGeminiFileState = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<string> => {
  const response = await customFetch(fileUri, {
    method: "GET",
    headers: { "x-goog-api-key": apiKey.trim() },
    signal,
  });
  await ensureOk(response);
  const data = (await response.json()) as {
    state?: string;
    file?: { state?: string };
  };
  const state = data.state ?? data.file?.state;
  if (!state) {
    // Unrecognised shape: treat as PROCESSING to keep polling, not ACTIVE.
    return "PROCESSING";
  }
  if (state === "FAILED") throw new GeminiFileProcessingError();
  return state;
};

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    }
  });

/**
 * How the state endpoint is polled while the upload finishes.
 *
 * These used to be ten attempts at a fixed 100 ms, so the whole wait was about
 * one second plus request round trips. Gemini's Files API routinely needs longer
 * than that to process a real recording, so the loop exhausted and threw, and
 * `tryUploadWithFallback` turned that into an inlineData request. The fallback
 * cannot recover a recording over the inline request size limit, so the dictation
 * failed with no visible cause.
 *
 * Now it backs off, and the total wait is bounded by a deadline rather than by
 * the attempt count, because what matters is how long the file is allowed to
 * become ready. The attempt cap still applies so a state endpoint that answers
 * instantly and never reaches ACTIVE cannot spin.
 */
/** The one sub-500 status worth retrying: Gemini rate-limits per project. */
const RATE_LIMITED_STATUS = 429;

const FILE_POLL_MAX_ATTEMPTS = 30;
const FILE_POLL_INITIAL_INTERVAL_MS = 100;
const FILE_POLL_MAX_INTERVAL_MS = 2_000;
const FILE_POLL_DEADLINE_MS = 30_000;

/** Backoff for `attempt`, doubling from the initial gap up to the cap. */
const filePollInterval = (attempt: number): number =>
  Math.min(
    FILE_POLL_INITIAL_INTERVAL_MS * 2 ** attempt,
    FILE_POLL_MAX_INTERVAL_MS,
  );

/** What one poll of the upload's state endpoint decided. */
type FilePollOutcome = "active" | "pending";

/**
 * One poll of an upload's state endpoint, with the failure policy attached.
 *
 * A 4xx is permanent, so it is rethrown rather than polled through silently: a
 * key that cannot read the file will not read it in 100ms either, and swallowing
 * it would turn a real error into a generic "never became ACTIVE" ten tries
 * later. Anything else is the endpoint being briefly unavailable while the
 * upload finishes, which is what the next attempt is for.
 */
const pollGeminiFileState = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<FilePollOutcome> => {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  try {
    const state = await fetchGeminiFileState(
      fileUri,
      apiKey,
      customFetch,
      signal,
    );
    return state === "ACTIVE" ? "active" : "pending";
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof GeminiFileProcessingError) throw error;
    // `429` is the one 4xx that means "later". It used to be rethrown with the rest of the
    // sub-500 range, so a transient rate limit abandoned the uploaded file and fell back to
    // inline audio -- which cannot carry a large recording, and is the failure the Files
    // path exists to prevent. Every other sub-500 status stays permanent: 400 (bad request),
    // 401/403 (bad key) and 404 (unknown file) do not fix themselves, and retrying them would
    // spend the whole deadline before falling back.
    //
    // This is the one place that reads a `GeminiHttpError`'s status on a polling path, so it
    // is also the place the class's own doc comment describes: preserving `retryAfter` "so
    // retry helpers can distinguish a permanent client error (400/401/403/404) from a
    // transient rate limit or server failure".
    if (
      error instanceof GeminiHttpError &&
      error.status < 500 &&
      error.status !== RATE_LIMITED_STATUS
    ) {
      throw error;
    }
    return "pending";
  }
};

const waitForGeminiFileActive = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<void> => {
  const startedAt = Date.now();
  // The poll is one request at a time by design: the state endpoint is polled
  // on a backoff that grows with the attempt count, and every step decides
  // whether there is a next step at all. Recursion states that dependency,
  // where a loop that awaits would look like work that could safely overlap.
  const pollAt = async (attempt: number): Promise<boolean> => {
    if (attempt >= FILE_POLL_MAX_ATTEMPTS) {
      return false;
    }
    if (Date.now() - startedAt >= FILE_POLL_DEADLINE_MS) {
      return false;
    }
    const outcome = await pollGeminiFileState(
      fileUri,
      apiKey,
      customFetch,
      signal,
    );
    if (outcome === "active") {
      return true;
    }
    // A cancel during the wait rejects here with the caller's reason, so the
    // poll stops on the signal rather than sitting out the last interval.
    await delay(filePollInterval(attempt), signal);
    return pollAt(attempt + 1);
  };

  if (await pollAt(0)) {
    return;
  }
  throw new Error(
    `Gemini file did not become ACTIVE within ${
      FILE_POLL_DEADLINE_MS / 1_000
    }s of polling`,
  );
};

type AudioTranscriptionConfig = {
  languageCodes?: string[];
  customVocabulary?: string[];
  mode: string;
  diarization?: boolean;
  wordTimestamp?: boolean;
};

export const GEMINI_MAX_CUSTOM_VOCABULARY_TERMS = 1000;
export const GEMINI_MAX_CUSTOM_VOCABULARY_TERM_LENGTH = 100;

const buildAudioTranscriptionConfig = (args: {
  language?: string;
  rawVocabulary?: string[];
  transcriptionMode: "verbatim" | "smart";
  enableDiarization: boolean;
  enableWordTimestamps: boolean;
}): AudioTranscriptionConfig => {
  const languageCodes =
    args.language && args.language !== "auto"
      ? [normalizeGeminiLanguageCode(args.language)]
      : [];

  const vocab = args.rawVocabulary
    ? args.rawVocabulary
        .map((s) => s.trim().slice(0, GEMINI_MAX_CUSTOM_VOCABULARY_TERM_LENGTH))
        .filter(Boolean)
        .slice(0, GEMINI_MAX_CUSTOM_VOCABULARY_TERMS)
    : undefined;

  const config: AudioTranscriptionConfig = {
    ...(languageCodes.length > 0 ? { languageCodes } : {}),
    ...(vocab && vocab.length > 0 ? { customVocabulary: vocab } : {}),
    mode: args.transcriptionMode.toUpperCase(),
    ...(args.enableDiarization ? { diarization: true } : {}),
    ...(args.enableWordTimestamps ? { wordTimestamp: true } : {}),
  };

  // API constraint: custom_vocabulary is incompatible with diarization and
  // word timestamps. Documented at https://ai.google.dev/gemini-api/docs/transcribe
  if (
    vocab &&
    vocab.length > 0 &&
    (args.enableDiarization || args.enableWordTimestamps)
  ) {
    delete config.customVocabulary;
  }

  // API constraint: SMART mode is incompatible with diarization/timestamps.
  // Fall back to VERBATIM per docs.
  if (
    args.transcriptionMode === "smart" &&
    (args.enableDiarization || args.enableWordTimestamps)
  ) {
    config.mode = "VERBATIM";
  }

  return config;
};

const resolveVocabularyForDedicated = (
  customVocabulary: string[] | undefined,
): string[] | undefined => {
  // Dedicated transcribe model: only use explicit customVocabulary, never
  // parse the prompt. Prompt is a localized instruction template (Glossary,
  // "consider this glossary" sentence) that would be comma-split into bogus
  // terms if treated as vocabulary. Empty array means "no vocabulary".
  if (customVocabulary !== undefined) {
    return customVocabulary.length > 0 ? customVocabulary : undefined;
  }
  return undefined;
};

export type GeminiTranscriptionArgs = {
  apiKey: string;
  model?: GeminiTranscriptionModel;
  blob: ArrayBuffer | Buffer;
  mimeType?: string;
  prompt?: string;
  language?: string;
  customVocabulary?: string[];
  transcriptionMode?: "verbatim" | "smart";
  enableDiarization?: boolean;
  enableWordTimestamps?: boolean;
  /** Aborts the request and stops any retry loop when cancelled. */
  signal?: AbortSignal;
  customFetch?: CustomFetch;
};

export type GeminiTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

const tryUploadWithFallback = async (args: {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  mimeType: string;
  customFetch: CustomFetch;
  signal?: AbortSignal;
}): Promise<{ uri?: string; mimeType: string }> => {
  let uploadedUri: string | undefined;
  try {
    const uploaded = await uploadGeminiFile(
      args.apiKey,
      args.blob,
      args.mimeType,
      args.customFetch,
      args.signal,
    );
    uploadedUri = uploaded.uri;
    await waitForGeminiFileActive(
      uploaded.uri,
      args.apiKey,
      args.customFetch,
      args.signal,
    );
    return { uri: uploaded.uri, mimeType: uploaded.mimeType };
  } catch (error) {
    if (uploadedUri) {
      await deleteGeminiFile(
        uploadedUri,
        args.apiKey,
        args.customFetch,
        args.signal,
      );
    }
    if (args.signal?.aborted) throw error;
    // For upload path, fallback to inlineData on any failure except abort,
    // even permanent 4xx (413 too large, 400 bad mimeType, 401/403) – pre-PR
    // code always used inlineData and would have completed.
    const truncated =
      error instanceof Error
        ? error.message.slice(0, 200)
        : String(error).slice(0, 200);
    console.warn(
      `Gemini Files API upload failed, falling back to inlineData: ${truncated}`,
    );
    return { uri: undefined, mimeType: args.mimeType };
  }
};

const buildAudioPart = (
  fileUri: string | undefined,
  mimeType: string,
  blob: ArrayBuffer | Buffer,
): GeminiPart => {
  if (fileUri) {
    return { fileData: { mimeType, fileUri } };
  }
  return {
    inlineData: { mimeType, data: arrayBufferToBase64(blob) },
  };
};

const transcribeWithDedicatedModel = async (args: {
  apiKey: string;
  model: string;
  blob: ArrayBuffer | Buffer;
  mimeType: string;
  prompt?: string;
  language?: string;
  customVocabulary?: string[];
  transcriptionMode: "verbatim" | "smart";
  enableDiarization: boolean;
  enableWordTimestamps: boolean;
  customFetch: CustomFetch;
  signal?: AbortSignal;
}): Promise<GeminiTranscribeAudioOutput> => {
  const uploaded = await tryUploadWithFallback({
    apiKey: args.apiKey,
    blob: args.blob,
    mimeType: args.mimeType,
    customFetch: args.customFetch,
    signal: args.signal,
  });

  const audioPart = buildAudioPart(uploaded.uri, uploaded.mimeType, args.blob);
  // For dedicated STT models, prompt is NOT used as vocabulary – it is a
  // localized instruction template that would be mis-parsed as glossary terms.
  // Only explicit customVocabulary is forwarded.
  const rawVocab = resolveVocabularyForDedicated(args.customVocabulary);
  const generationConfig = {
    audioTranscriptionConfig: buildAudioTranscriptionConfig({
      language: args.language,
      rawVocabulary: rawVocab,
      transcriptionMode: args.transcriptionMode,
      enableDiarization: args.enableDiarization,
      enableWordTimestamps: args.enableWordTimestamps,
    }),
  };

  try {
    const httpResponse = await requestGemini(
      args.apiKey,
      args.model,
      "generateContent",
      {
        contents: [{ role: "user", parts: [audioPart] }],
        generationConfig,
      },
      args.customFetch,
      args.signal,
    );
    const response =
      (await httpResponse.json()) as GeminiGenerateContentResponse;
    const text = getGeminiTranscriptionText(response);
    return { text, wordsUsed: countWords(text) };
  } finally {
    if (uploaded.uri) {
      await deleteGeminiFile(
        uploaded.uri,
        args.apiKey,
        args.customFetch,
        args.signal,
      );
    }
  }
};

const transcribeWithGeneralModel = async (args: {
  apiKey: string;
  model: string;
  blob: ArrayBuffer | Buffer;
  mimeType: string;
  prompt?: string;
  language?: string;
  customFetch: CustomFetch;
  signal?: AbortSignal;
}): Promise<GeminiTranscribeAudioOutput> => {
  const base64Audio = arrayBufferToBase64(args.blob);
  let transcriptionPrompt = "Transcribe this audio accurately.";
  if (args.language && args.language !== "auto") {
    transcriptionPrompt += ` The audio is in ${args.language}.`;
  }
  if (args.prompt) {
    transcriptionPrompt += ` Context: ${args.prompt}`;
  }

  const httpResponse = await requestGemini(
    args.apiKey,
    args.model,
    "generateContent",
    {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: args.mimeType, data: base64Audio } },
            { text: transcriptionPrompt },
          ],
        },
      ],
    },
    args.customFetch,
    args.signal,
  );
  const response = (await httpResponse.json()) as GeminiGenerateContentResponse;
  const text = getGeminiTranscriptionText(response);
  return { text, wordsUsed: countWords(text) };
};

/**
 * One absolute deadline for the whole operation, shared across upload,
 * polling and generateContent attempts. Prevents leaked retries after
 * cancellation and bounds total wall time.
 */
export const geminiTranscribeAudio = ({
  apiKey,
  model = GEMINI_TRANSCRIPTION_MODELS[0],
  blob,
  mimeType = "audio/wav",
  prompt,
  language,
  customVocabulary,
  transcriptionMode = "verbatim",
  enableDiarization = false,
  enableWordTimestamps = false,
  signal,
  customFetch = fetch,
}: GeminiTranscriptionArgs): Promise<GeminiTranscribeAudioOutput> => {
  const deadlineSignal = withDeadlineSignal(signal);
  return retry({
    retries: 3,
    isRetryable: (err) => isGeminiFailureRetryable(err, deadlineSignal),
    // The deadline signal ends the wait between attempts, so a cancelled or
    // timed-out operation stops there instead of sitting the wait out. The
    // hint is real here, unlike at the OpenAI-compatible providers:
    // `requestGemini` throws a `GeminiHttpError`, an `HttpError` carrying the
    // `retry-after` header, so a 429 wait grows to the hint. `maxRetryDelayMs`
    // is left at its 2s default, far short of the five-minute deadline.
    signal: deadlineSignal,
    // Not `async`: both branches already return the promise they were given,
    // and `retry` awaits the thunk inside a try, so a synchronous failure on
    // either branch is still seen as a failure rather than escaping the loop.
    fn: () =>
      isGeminiTranscribeModel(model)
        ? transcribeWithDedicatedModel({
            apiKey,
            model,
            blob,
            mimeType,
            prompt,
            language,
            customVocabulary,
            transcriptionMode,
            enableDiarization,
            enableWordTimestamps,
            customFetch,
            signal: deadlineSignal,
          })
        : transcribeWithGeneralModel({
            apiKey,
            model,
            blob,
            mimeType,
            prompt,
            language,
            customFetch,
            signal: deadlineSignal,
          }),
  });
};

export type GeminiGenerateTextArgs = {
  apiKey: string;
  model?: GeminiGenerateTextModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  /** Aborts the request and stops any retry loop when cancelled. */
  signal?: AbortSignal;
  customFetch?: CustomFetch;
};

export type GeminiGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

/**
 * One absolute deadline per operation, shared across attempts, with
 * AbortController that is aborted on timeout or on caller's signal.
 */
export const geminiGenerateTextResponse = ({
  apiKey,
  model = GEMINI_GENERATE_TEXT_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  signal,
  customFetch = fetch,
}: GeminiGenerateTextArgs): Promise<GeminiGenerateResponseOutput> => {
  const deadlineSignal = withDeadlineSignal(signal);
  return retry({
    retries: 3,
    isRetryable: (err) => isGeminiFailureRetryable(err, deadlineSignal),
    // The deadline signal ends the wait between attempts, so a cancelled or
    // timed-out operation stops there instead of sitting the wait out. The
    // hint is real here, unlike at the OpenAI-compatible providers:
    // `requestGemini` throws a `GeminiHttpError`, an `HttpError` carrying the
    // `retry-after` header, so a 429 wait grows to the hint. `maxRetryDelayMs`
    // is left at its 2s default, far short of the five-minute deadline.
    signal: deadlineSignal,
    fn: async () => {
      let fullPrompt = prompt;
      if (system) {
        fullPrompt = `${system}\n\n${prompt}`;
      }

      const generationConfig: Record<string, unknown> = {};
      if (maxTokens !== undefined) {
        generationConfig.maxOutputTokens = maxTokens;
      }
      // Thinking tokens are charged against maxOutputTokens, so a default
      // thinking pass can consume the whole post-processing budget before any
      // JSON is written. See reasoning.utils.
      const thinkingConfig = buildGeminiThinkingConfig(model);
      if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }
      if (jsonResponse) {
        generationConfig.responseMimeType = "application/json";
        if (jsonResponse.schema) {
          // JSON Schema is not the legacy OpenAPI/protobuf Schema dialect that
          // Gemini generateContent historically used; we pass through as-is for
          // forward compat but note it may be ignored on older models.
          generationConfig.responseJsonSchema = jsonResponse.schema;
        }
      }

      const httpResponse = await requestGemini(
        apiKey,
        model,
        "generateContent",
        {
          contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
          generationConfig:
            Object.keys(generationConfig).length > 0
              ? generationConfig
              : undefined,
        },
        customFetch,
        deadlineSignal,
      );
      const response =
        (await httpResponse.json()) as GeminiGenerateContentResponse;
      const text = getGeminiResponseText(response);
      if (!text) {
        throw new Error("No response from Gemini");
      }

      const usageMetadata = response.usageMetadata;
      const tokensUsed = usageMetadata?.totalTokenCount ?? countWords(text);

      return { text, tokensUsed };
    },
  });
};

export type GeminiTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const geminiTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: GeminiTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${GEMINI_API_URL}/models?pageSize=1`, {
    headers: { "x-goog-api-key": apiKey.trim() },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Gemini responded ${response.status}: ${detail}`
        : `Gemini responded with status ${response.status}`,
    );
  }
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

function geminiAssistantParts(
  msg: Extract<LlmMessage, { role: "assistant" }>,
  functionNameByToolCallId: Map<string, string>,
): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (msg.content) {
    parts.push({ text: msg.content });
  }
  for (const tc of msg.toolCalls ?? []) {
    functionNameByToolCallId.set(tc.id, tc.name);
    const parsedArgs = parseJsonObject(tc.arguments) ?? {};
    parts.push({
      functionCall: { name: tc.name, args: parsedArgs },
    });
  }
  return parts;
}

function llmMessagesToGemini(messages: LlmMessage[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];
  // Tool-call ids are synthetic per provider turn (e.g. `gemini-tc-0`), while
  // Gemini's functionResponse must name the declared *function*. Track the
  // id -> name mapping from assistant turns so results pair correctly.
  const functionNameByToolCallId = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content;
      continue;
    }

    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts = geminiAssistantParts(msg, functionNameByToolCallId);
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "tool") {
      const functionName = functionNameByToolCallId.get(msg.toolCallId);
      if (!functionName) {
        // An orphaned tool result has no matching functionCall, so Gemini
        // would reject the whole request. Drop it; the conversation keeps the
        // visible answer context without the bogus reference.
        continue;
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: functionName,
              response: { result: msg.content },
            },
          },
        ],
      });
    }
  }

  return { systemInstruction, contents };
}

function geminiFinishReason(raw: string | undefined): LlmFinishReason {
  switch (raw) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content-filter";
    default:
      return "other";
  }
}

export type GeminiStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  /** Aborts the in-flight request and stream when cancelled. */
  signal?: AbortSignal;
  customFetch?: CustomFetch;
};

type GeminiChunkState = {
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: LlmFinishReason;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  toolCallCounter: number;
};

type GeminiChunkEvent = { type: "text-delta"; text: string };

const buildGeminiTools = (
  input: LlmChatInput,
): GeminiFunctionDeclaration[] | undefined => {
  if (!input.tools || input.tools.length === 0) {
    return undefined;
  }
  return input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
      ? convertJsonSchemaToGeminiSchema(t.parameters as Record<string, unknown>)
      : undefined,
  }));
};

/**
 * Map the shared tool choice onto Gemini's `toolConfig`.
 *
 * The three options exist on both sides, under different names, and Gemini
 * expresses "only this one" as an allow-list inside `ANY` rather than as a
 * fourth mode. Leaving the field off is not neutral: Gemini then defaults to
 * `AUTO`, so a caller that selected `none` can still get a tool call and one
 * that selected `required` can still get prose instead of the call it asked
 * for.
 */
const buildGeminiToolConfig = (
  toolChoice: LlmToolChoice | undefined,
  hasTools: boolean,
): GeminiToolConfig | undefined => {
  // Nothing to choose between, and nothing to forbid: Gemini rejects a
  // `toolConfig` on a request that declares no function at all.
  if (!toolChoice || !hasTools) return undefined;
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
        return { functionCallingConfig: { mode: "AUTO" } };
      case "required":
        return { functionCallingConfig: { mode: "ANY" } };
      case "none":
        return { functionCallingConfig: { mode: "NONE" } };
    }
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [toolChoice.name],
    },
  };
};

/**
 * The finish reason for a completed Gemini turn.
 *
 * Gemini has no tool-call finish reason: a turn that ends in function-call
 * parts is reported as a plain STOP, which reads as "the model finished
 * talking" on a turn that is actually waiting on tool results. OpenAI and
 * Anthropic both name that turn `tool-calls`, and the emitted parts are the
 * only signal this API gives, so they are read as the reason they mean.
 *
 * The upgrade is deliberately narrow. Only an otherwise ordinary end-of-turn
 * is re-read, because a turn that was truncated or filtered is not waiting on
 * a tool result and the more specific reason is the one a consumer needs.
 */
const geminiTurnFinishReason = (state: GeminiChunkState): LlmFinishReason =>
  state.pendingToolCalls.length > 0 && state.finishReason === "stop"
    ? "tool-calls"
    : state.finishReason;

const processGeminiChunk = (
  chunk: GeminiGenerateContentResponse,
  state: GeminiChunkState,
): GeminiChunkEvent[] => {
  const events: GeminiChunkEvent[] = [];
  // Usage is read BEFORE the candidate check, because the two are independent and a frame
  // can carry one without the other. It used to be read after, which meant the early return
  // below discarded `usageMetadata` on any frame without `candidates` -- and the frame that
  // reports token counts is exactly the kind that need not carry content, since a turn cut
  // short by a content filter or a max-token stop has a finish reason and nothing to say.
  //
  // Measured on one payload differing only in the presence of `candidates`:
  //
  //     with candidates   finish{finishReason:"stop", usage:{promptTokens:111, ...}}
  //     usage only        finish{finishReason:"stop"}
  if (chunk.usageMetadata) {
    state.promptTokens = chunk.usageMetadata.promptTokenCount ?? undefined;
    state.completionTokens =
      chunk.usageMetadata.candidatesTokenCount ?? undefined;
  }
  const candidate = chunk.candidates?.[0];
  if (!candidate) return events;
  for (const part of candidate.content?.parts ?? []) {
    if (part.text) {
      events.push({ type: "text-delta", text: part.text });
    }

    if (part.functionCall) {
      state.pendingToolCalls.push({
        id: `gemini-tc-${state.toolCallCounter++}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }

  if (candidate.finishReason) {
    state.finishReason = geminiFinishReason(candidate.finishReason as string);
  }

  return events;
};

const parseGeminiSseEvent = (
  event: string,
): GeminiGenerateContentResponse | undefined => {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;

  try {
    return JSON.parse(data) as GeminiGenerateContentResponse;
  } catch {
    throw new Error("Gemini returned malformed SSE data");
  }
};

const parseGeminiSseEvents = (
  events: string[],
): GeminiGenerateContentResponse[] =>
  events
    .map(parseGeminiSseEvent)
    .filter((event): event is GeminiGenerateContentResponse => event != null);

const splitGeminiSseBuffer = (
  buffer: string,
  done: boolean,
): { events: string[]; remainder: string } => {
  const events = buffer.split(/\r?\n\r?\n/);
  const remainder = done ? "" : (events.pop() ?? "");
  return { events, remainder };
};

/**
 * The reader's own read results, in order, as something a `for await` can
 * consume.
 *
 * A stream reader hands out one chunk at a time and refuses a second read
 * while the first is outstanding, so the reads cannot overlap however the
 * loop around them is written. Exposing them as an iterable says that once:
 * each `next` is a single read, the consumer's `for await` supplies the
 * repetition, and the terminal result is yielded like any other so the
 * consumer still sees the flush.
 */
const readerResults = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<ReadableStreamReadResult<Uint8Array>> => ({
  [Symbol.asyncIterator]: () => {
    let finished = false;
    return {
      next: async (): Promise<
        IteratorResult<ReadableStreamReadResult<Uint8Array>>
      > => {
        if (finished) {
          return { done: true, value: undefined };
        }
        const result = await reader.read();
        finished = result.done;
        return { done: false, value: result };
      },
    };
  },
});

async function* parseGeminiSse(
  response: Response,
): AsyncGenerator<GeminiGenerateContentResponse> {
  if (!response.body) {
    yield* parseGeminiSseEvents([await response.text()]);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const result of readerResults(reader)) {
      buffer += decoder.decode(result.value, { stream: !result.done });

      const parsed = splitGeminiSseBuffer(buffer, result.done);
      buffer = parsed.remainder;
      yield* parseGeminiSseEvents(parsed.events);
    }
  } finally {
    // Ensure reader is cancelled to free underlying fetch resources.
    // reader.cancel() is best-effort.
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Releasing can throw when a read is mid-flight; the cancelled stream
      // is still closed by the awaited cancel above.
    }
  }
}

export async function* geminiStreamChat({
  apiKey,
  model,
  input,
  signal = input.signal,
  customFetch = fetch,
}: GeminiStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const { systemInstruction, contents } = llmMessagesToGemini(input.messages);
  const tools = buildGeminiTools(input);
  const toolConfig = buildGeminiToolConfig(input.toolChoice, Boolean(tools));
  const generationConfig = {
    maxOutputTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
    stopSequences: input.stopSequences,
  };
  const hasGenerationConfig = Object.values(generationConfig).some(
    (value) => value !== undefined,
  );
  const response = await requestGemini(
    apiKey,
    model,
    "streamGenerateContent",
    {
      contents,
      systemInstruction: systemInstruction
        ? { parts: [{ text: systemInstruction }] }
        : undefined,
      tools: tools ? [{ functionDeclarations: tools }] : undefined,
      toolConfig,
      generationConfig: hasGenerationConfig ? generationConfig : undefined,
    },
    customFetch,
    signal,
  );

  const state: GeminiChunkState = {
    pendingToolCalls: [],
    finishReason: "other",
    promptTokens: undefined,
    completionTokens: undefined,
    toolCallCounter: 0,
  };

  let sawStreamChunk = false;
  for await (const chunk of parseGeminiSse(response)) {
    sawStreamChunk = true;
    for (const event of processGeminiChunk(chunk, state)) {
      yield event;
    }
  }
  if (!sawStreamChunk) {
    throw new Error(
      "Gemini returned an empty or non-SSE streaming response (expected event-stream data)",
    );
  }

  for (const tc of state.pendingToolCalls) {
    yield {
      type: "tool-call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }

  yield {
    type: "finish",
    finishReason: geminiTurnFinishReason(state),
    usage:
      state.promptTokens != null || state.completionTokens != null
        ? {
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
          }
        : undefined,
  };
}
