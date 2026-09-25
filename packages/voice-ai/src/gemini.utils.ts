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

const isGeminiTranscribeModel = (model: string): boolean =>
  model.includes("-transcribe") && !model.includes("-live");

const arrayBufferToBase64 = (
  buffer: ArrayBuffer | Uint8Array | Buffer,
): string => {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer as ArrayBuffer);
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(bytes).toString("base64");
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

const uploadGeminiFile = async (
  apiKey: string,
  blob: ArrayBuffer | Buffer,
  mimeType: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<{ uri: string; mimeType: string }> => {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : new Uint8Array(blob as ArrayBuffer | Buffer as ArrayBuffer);
  const byteLength = bytes.byteLength;

  const startResponse = await customFetch(GEMINI_UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey.trim(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({
      file: { display_name: `mausvoice-${Date.now()}.wav` },
    }),
    signal,
  });

  if (!startResponse.ok) {
    const detail = await startResponse.text().catch(() => "");
    throw new GeminiHttpError(startResponse.status, detail);
  }

  const uploadUrl =
    startResponse.headers.get("x-goog-upload-url") ??
    startResponse.headers.get("X-Goog-Upload-URL");

  if (!uploadUrl) {
    throw new Error("Gemini Files API did not return an upload URL");
  }

  const uploadResponse = await customFetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes as unknown as BodyInit,
    signal,
  });

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => "");
    throw new GeminiHttpError(uploadResponse.status, detail);
  }

  const payload = (await uploadResponse.json()) as {
    file?: {
      uri?: string;
      mimeType?: string;
      mime_type?: string;
      state?: string;
      name?: string;
    };
    state?: string;
  };

  const uri = payload.file?.uri;
  if (!uri) {
    throw new Error(
      "Gemini Files API upload succeeded but returned no file URI",
    );
  }

  return {
    uri,
    mimeType: payload.file?.mimeType ?? payload.file?.mime_type ?? mimeType,
  };
};

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
  } catch {
    // Best-effort cleanup: storage quota leak is not fatal to transcription.
  }
};

const fetchGeminiFileState = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<string> => {
  const response = await customFetch(fileUri, {
    headers: { "x-goog-api-key": apiKey.trim() },
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GeminiHttpError(response.status, detail);
  }
  const data = (await response.json()) as {
    state?: string;
    file?: { state?: string };
  };
  return data.state ?? data.file?.state ?? "ACTIVE";
};

const waitForGeminiFileActive = async (
  fileUri: string,
  apiKey: string,
  customFetch: CustomFetch,
  signal?: AbortSignal,
): Promise<void> => {
  const maxAttempts = 10;
  const delayMs = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const state = await fetchGeminiFileState(
        fileUri,
        apiKey,
        customFetch,
        signal,
      );
      if (state === "ACTIVE") return;
      if (state === "FAILED") throw new Error("Gemini file processing failed");
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof GeminiHttpError && error.status < 500) throw error;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener("abort", () => clearTimeout(timer), {
        once: true,
      });
    });
  }
};

type AudioTranscriptionConfig = {
  languageCodes?: string[];
  customVocabulary?: string[];
  mode: string;
  diarization?: boolean;
  wordTimestamp?: boolean;
};

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
        .map((s) => s.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 1000)
    : undefined;

  const config: AudioTranscriptionConfig = {
    ...(languageCodes.length > 0 ? { languageCodes } : {}),
    ...(vocab && vocab.length > 0 ? { customVocabulary: vocab } : {}),
    mode: args.transcriptionMode.toUpperCase(),
    ...(args.enableDiarization ? { diarization: true } : {}),
    ...(args.enableWordTimestamps ? { wordTimestamp: true } : {}),
  };

  if (
    vocab &&
    vocab.length > 0 &&
    (args.enableDiarization || args.enableWordTimestamps)
  ) {
    delete config.customVocabulary;
  }

  if (
    args.transcriptionMode === "smart" &&
    (args.enableDiarization || args.enableWordTimestamps)
  ) {
    config.mode = "VERBATIM";
  }

  return config;
};

const resolveVocabulary = (
  customVocabulary: string[] | undefined,
  prompt: string | undefined,
): string[] | undefined => {
  // When customVocabulary is explicitly provided (even empty), do not fall
  // back to parsing the prompt. Empty array means "no vocabulary".
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
  let fileUri: string | undefined;
  let fileMimeType = args.mimeType;

  try {
    const uploaded = await uploadGeminiFile(
      args.apiKey,
      args.blob,
      args.mimeType,
      args.customFetch,
      args.signal,
    );
    fileUri = uploaded.uri;
    fileMimeType = uploaded.mimeType;
    await waitForGeminiFileActive(
      fileUri,
      args.apiKey,
      args.customFetch,
      args.signal,
    );
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (!isGeminiFailureRetryable(error, args.signal)) {
      throw error;
    }
    console.warn(
      `Gemini Files API upload failed, falling back to inlineData: ${error instanceof Error ? error.message : String(error)}`,
    );
    fileUri = undefined;
  }

  const audioPart = fileUri
    ? { fileData: { mimeType: fileMimeType, fileUri } }
    : {
        inlineData: {
          mimeType: args.mimeType,
          data: arrayBufferToBase64(args.blob),
        },
      };

  const rawVocab = resolveVocabulary(args.customVocabulary, args.prompt);
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
        contents: [{ role: "user", parts: [audioPart as GeminiPart] }],
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
    if (fileUri) {
      await deleteGeminiFile(
        fileUri,
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
  const text = getGeminiResponseText(response);
  if (!text) throw new Error("Transcription failed - empty response");
  return { text, wordsUsed: countWords(text) };
};

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
