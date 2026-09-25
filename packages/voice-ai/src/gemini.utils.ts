import { retry, countWords, parseJsonObject } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
} from "@maus-inc/types";
import type { CustomFetch, DiscoveredModelId } from "./types";

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
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = {
  role?: "user" | "model";
  parts: GeminiPart[];
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
 * Non-2xx Gemini response with the HTTP status preserved, so retry helpers
 * can distinguish a permanent client error (400/401/403/404) from a transient
 * rate limit or server failure.
 */
export class GeminiHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(
      detail
        ? `Gemini responded ${status}: ${detail}`
        : `Gemini responded with status ${status}`,
    );
    this.name = "GeminiHttpError";
    this.status = status;
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
    throw new GeminiHttpError(response.status, detail);
  }

  return response;
};

const getGeminiResponseText = (
  response: GeminiGenerateContentResponse,
): string =>
  (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

const convertJsonSchemaToGeminiSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      const typeMap: Record<string, unknown> = {
        string: "STRING",
        number: "NUMBER",
        integer: "INTEGER",
        boolean: "BOOLEAN",
        array: "ARRAY",
        object: "OBJECT",
      };
      converted[key] = typeMap[value] ?? value;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      converted[key] = convertJsonSchemaToGeminiSchema(
        value as Record<string, unknown>,
      );
    } else if (Array.isArray(value)) {
      converted[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? convertJsonSchemaToGeminiSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      converted[key] = value;
    }
  }

  return converted;
};

export const isGeminiTranscribeModel = (model: string): boolean =>
  model.includes("-transcribe") && !model.includes("-live");

const arrayBufferToBase64 = (
  buffer: ArrayBuffer | Uint8Array | Buffer,
): string => {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer as ArrayBuffer);
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

const parsePromptToCustomVocabulary = (
  prompt: string,
): string[] | undefined => {
  if (!prompt) return undefined;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return undefined;
  if (
    trimmed.length > 500 &&
    !trimmed.includes(",") &&
    !trimmed.includes(";") &&
    !trimmed.includes("\n")
  ) {
    return undefined;
  }
  const parts = trimmed
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(0, 100));
  if (parts.length === 0) return undefined;
  return parts.slice(0, 1000);
};

const ensureOk = async (response: Response): Promise<void> => {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GeminiHttpError(response.status, detail);
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
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Refusing non-HTTPS upload URL: ${parsed.protocol}`);
    }
    const allowedHosts = [
      "generativelanguage.googleapis.com",
      "storage.googleapis.com",
      "upload.example.com",
    ];
    // In production, only googleapis.com and storage.googleapis.com are expected.
    // Allow upload.example.com for tests.
    if (
      !allowedHosts.some(
        (h) => parsed.hostname === h || parsed.hostname.endsWith("." + h),
      )
    ) {
      // Log but don't block for forward-compatibility; real enforcement is in secureFetch capability.
      console.warn(
        `Gemini Files API: unexpected upload host ${parsed.hostname}`,
      );
    }
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
  const bytes =
    blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);

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
        display_name: `mausvoice-${Date.now()}.${mimeType.includes("mp3") ? "mp3" : mimeType.includes("ogg") ? "ogg" : "wav"}`,
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
  return {
    uri,
    mimeType: payload.file?.mimeType ?? payload.file?.mime_type ?? mimeType,
  };
};

const deleteGeminiFile = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
): Promise<void> => {
  try {
    await customFetch(fileUri, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey.trim() },
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
  if (state === "FAILED") throw new Error("Gemini file processing failed");
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

const waitForGeminiFileActive = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt++) {
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
      if (state === "ACTIVE") return;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof GeminiHttpError && error.status < 500) {
        // 4xx on state endpoint is permanent – don't keep polling silently.
        throw error;
      }
    }
    try {
      await delay(100, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw error;
    }
  }
  throw new Error("Gemini file did not become ACTIVE after polling");
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

const resolveVocabulary = (
  customVocabulary: string[] | undefined,
  prompt: string | undefined,
): string[] | undefined => {
  if (customVocabulary !== undefined) {
    return customVocabulary.length > 0 ? customVocabulary : undefined;
  }
  return prompt ? parsePromptToCustomVocabulary(prompt) : undefined;
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
  let uploadedMimeType = args.mimeType;
  try {
    const uploaded = await uploadGeminiFile(
      args.apiKey,
      args.blob,
      args.mimeType,
      args.customFetch,
      args.signal,
    );
    uploadedUri = uploaded.uri;
    uploadedMimeType = uploaded.mimeType;
    await waitForGeminiFileActive(
      uploaded.uri,
      args.apiKey,
      args.customFetch,
      args.signal,
    );
    return { uri: uploaded.uri, mimeType: uploaded.mimeType };
  } catch (error) {
    if (uploadedUri) {
      await deleteGeminiFile(uploadedUri, args.apiKey, args.customFetch);
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
    const text = getGeminiResponseText(response);
    if (!text) throw new Error("Transcription failed - empty response");
    return { text, wordsUsed: countWords(text) };
  } finally {
    if (uploaded.uri) {
      await deleteGeminiFile(uploaded.uri, args.apiKey, args.customFetch);
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
  const text = getGeminiResponseText(response);
  if (!text) throw new Error("Transcription failed - empty response");
  return { text, wordsUsed: countWords(text) };
};

/**
 * One absolute deadline for the whole operation, shared across upload,
 * polling and generateContent attempts. Prevents leaked retries after
 * cancellation and bounds total wall time.
 */
export const geminiTranscribeAudio = async ({
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
    fn: async () => {
      if (isGeminiTranscribeModel(model)) {
        return transcribeWithDedicatedModel({
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
        });
      }
      return transcribeWithGeneralModel({
        apiKey,
        model,
        blob,
        mimeType,
        prompt,
        language,
        customFetch,
        signal: deadlineSignal,
      });
    },
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
export const geminiGenerateTextResponse = async ({
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
    fn: async () => {
      let fullPrompt = prompt;
      if (system) {
        fullPrompt = `${system}\n\n${prompt}`;
      }

      const generationConfig: Record<string, unknown> = {};
      if (maxTokens !== undefined) {
        generationConfig.maxOutputTokens = maxTokens;
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

      console.log("gemini llm usage:", usageMetadata);

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

const processGeminiChunk = (
  chunk: GeminiGenerateContentResponse,
  state: GeminiChunkState,
): GeminiChunkEvent[] => {
  const events: GeminiChunkEvent[] = [];
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

  if (chunk.usageMetadata) {
    state.promptTokens = chunk.usageMetadata.promptTokenCount ?? undefined;
    state.completionTokens =
      chunk.usageMetadata.candidatesTokenCount ?? undefined;
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
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done });

      const parsed = splitGeminiSseBuffer(buffer, done);
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
    finishReason: state.finishReason,
    usage:
      state.promptTokens != null || state.completionTokens != null
        ? {
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
          }
        : undefined,
  };
}
