import { delayed } from "@maus-inc/utilities";
import type { CustomFetch } from "./types";

export type AssemblyAITestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const assemblyaiTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: AssemblyAITestIntegrationArgs): Promise<boolean> => {
  try {
    const response = await customFetch(
      "https://api.assemblyai.com/v2/transcript",
      {
        method: "GET",
        headers: { Authorization: apiKey },
      },
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
};

export type AssemblyAITranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  language?: string;
  /** Total time budget for the transcript to reach "completed" (default 180 s). */
  timeoutMs?: number;
  /** Delay between status polls (default 3 s). */
  pollIntervalMs?: number;
  customFetch?: CustomFetch;
};

export type AssemblyAITranscribeAudioOutput = {
  text: string;
};

const ASSEMBLYAI_API_URL = "https://api.assemblyai.com/v2";

type AssemblyAIUploadResponse = {
  upload_url?: string;
};

type AssemblyAITranscriptResponse = {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  text?: string;
  error?: string;
};

const assemblyaiHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: apiKey,
});

// Guarded JSON parse: a 2xx response with a non-JSON body (e.g. a proxy or
// load-balancer HTML error page) must surface a clean, prefixed error instead
// of an unwrapped SyntaxError escaping the caller.
const parseJsonResponse = async <T>(
  response: Response,
  errorLabel: string,
): Promise<T> => {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${errorLabel}: response was not valid JSON`);
  }
};

// Retry only transient failures: network errors, 5xx responses, and 429.
// Other 4xx responses (bad key, invalid request) will not succeed on retry.
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUS_CODES.has(status);

const getBackoffMs = (attempt: number): number =>
  Math.min(100 * 2 ** attempt, 5000);

const getResponseRetryDelayMs = (
  response: Response,
  attempt: number,
): number => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    // RFC 7231 allows either delta-seconds ("120") or an HTTP-date
    // ("Wed, 21 Oct 2015 07:28:00 GMT"); honor both forms.
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const retryDateMs = Date.parse(retryAfter);
    if (Number.isFinite(retryDateMs)) {
      return Math.max(0, retryDateMs - Date.now());
    }
  }
  return getBackoffMs(attempt);
};

const getBoundedRetryDelayMs = (
  response: Response | undefined,
  deadline: number | undefined,
  attempt: number,
): number => {
  const baseDelay =
    response !== undefined
      ? getResponseRetryDelayMs(response, attempt)
      : getBackoffMs(attempt);
  if (deadline === undefined) {
    return baseDelay;
  }
  return Math.min(baseDelay, Math.max(0, deadline - Date.now()));
};

const assertBeforeDeadline = (
  deadline: number | undefined,
  errorLabel: string,
): void => {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error(`${errorLabel}: timed out`);
  }
};

type RequestWithRetryOptions = {
  apiKey: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  errorLabel: string;
  maxRetries?: number;
  /** When set, the request is aborted once this absolute deadline passes. */
  signal?: AbortSignal;
  deadline?: number;
  customFetch?: CustomFetch;
};

// Handle a fetch-level failure (network error or abort). Throws when the
// retries are exhausted or the request was aborted; otherwise returns the
// delay before the next attempt.
const handleFetchError = (
  error: unknown,
  signal: AbortSignal | undefined,
  errorLabel: string,
  attempt: number,
  maxRetries: number,
  deadline: number | undefined,
): number => {
  if (signal?.aborted) {
    throw new Error(`${errorLabel}: timed out`);
  }
  if (attempt >= maxRetries) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorLabel}: ${message}`);
  }
  return getBoundedRetryDelayMs(undefined, deadline, attempt);
};

const requestWithRetry = async ({
  apiKey,
  url,
  method,
  headers = {},
  body,
  errorLabel,
  maxRetries = 3,
  signal,
  deadline,
  customFetch = fetch,
}: RequestWithRetryOptions): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    assertBeforeDeadline(deadline, errorLabel);

    let response: Response;
    try {
      response = await customFetch(url, {
        method,
        headers: { ...assemblyaiHeaders(apiKey), ...headers },
        body,
        signal,
      });
    } catch (error) {
      const delayMs = handleFetchError(
        error,
        signal,
        errorLabel,
        attempt,
        maxRetries,
        deadline,
      );
      await delayed(delayMs);
      continue;
    }

    if (response.ok) {
      return response;
    }

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`${errorLabel}: ${response.status} - ${errorText}`);
    }

    // Drain the response body before the retry delay: an unconsumed body can
    // keep the underlying connection from being released promptly, which
    // under sustained rate-limiting or server errors may exhaust the pool.
    await response.text().catch(() => undefined);

    await delayed(getBoundedRetryDelayMs(response, deadline, attempt));
  }
};

const ASSEMBLYAI_UPLOAD_ERROR = "AssemblyAI upload failed";
const ASSEMBLYAI_CREATE_ERROR = "AssemblyAI transcript request failed";
const ASSEMBLYAI_STATUS_ERROR = "AssemblyAI transcript status failed";

const uploadAudio = async (
  apiKey: string,
  arrayBuffer: ArrayBuffer,
  signal: AbortSignal,
  deadline: number,
  customFetch: CustomFetch,
): Promise<string> => {
  const response = await requestWithRetry({
    apiKey,
    url: `${ASSEMBLYAI_API_URL}/upload`,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: arrayBuffer,
    errorLabel: ASSEMBLYAI_UPLOAD_ERROR,
    signal,
    deadline,
    customFetch,
  });

  const { upload_url: uploadUrl } =
    await parseJsonResponse<AssemblyAIUploadResponse>(
      response,
      ASSEMBLYAI_UPLOAD_ERROR,
    );

  if (!uploadUrl) {
    throw new Error("AssemblyAI upload returned no audio URL");
  }

  return uploadUrl;
};

const createTranscriptRequest = async (
  apiKey: string,
  uploadUrl: string,
  language: string | undefined,
  signal: AbortSignal,
  deadline: number,
  customFetch: CustomFetch,
): Promise<string> => {
  const transcriptPayload: Record<string, unknown> = {
    audio_url: uploadUrl,
    speech_model: "best",
  };
  if (!language || language === "auto") {
    transcriptPayload.language_detection = true;
  } else {
    transcriptPayload.language_code = language;
  }

  const response = await requestWithRetry({
    apiKey,
    url: `${ASSEMBLYAI_API_URL}/transcript`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(transcriptPayload),
    errorLabel: ASSEMBLYAI_CREATE_ERROR,
    signal,
    deadline,
    customFetch,
  });

  const created = await parseJsonResponse<AssemblyAITranscriptResponse>(
    response,
    ASSEMBLYAI_CREATE_ERROR,
  );
  const transcriptId = created.id;
  if (!transcriptId) {
    throw new Error("AssemblyAI transcript request returned no ID");
  }

  return transcriptId;
};

const validatePositiveDuration = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `AssemblyAI transcription ${name} must be a positive finite number`,
    );
  }
};

const waitForTranscript = async (
  apiKey: string,
  transcriptId: string,
  signal: AbortSignal,
  deadline: number,
  pollIntervalMs: number,
  customFetch: CustomFetch,
): Promise<string> => {
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("AssemblyAI transcription timed out");
    }

    const response = await requestWithRetry({
      apiKey,
      url: `${ASSEMBLYAI_API_URL}/transcript/${transcriptId}`,
      method: "GET",
      errorLabel: ASSEMBLYAI_STATUS_ERROR,
      signal,
      deadline,
      customFetch,
    });
    const status = await parseJsonResponse<AssemblyAITranscriptResponse>(
      response,
      ASSEMBLYAI_STATUS_ERROR,
    );

    if (status.status === "completed") {
      const text = status.text?.trim() ?? "";
      if (!text) {
        throw new Error("AssemblyAI transcription returned no text");
      }
      return text;
    }

    if (status.status === "error") {
      throw new Error(
        `AssemblyAI transcription failed: ${status.error ?? "Unknown error"}`,
      );
    }

    await delayed(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
};

/**
 * Batch (stored-audio) transcription via AssemblyAI's REST v2 API:
 * upload the audio, create a transcript, then poll until it completes.
 * Used by the retranscribe/batch path; live dictation keeps the dedicated
 * v3 streaming WebSocket session instead.
 */
export const assemblyaiTranscribeAudio = async ({
  apiKey,
  blob,
  language,
  timeoutMs = 180_000,
  pollIntervalMs = 3000,
  customFetch = fetch,
}: AssemblyAITranscriptionArgs): Promise<AssemblyAITranscribeAudioOutput> => {
  validatePositiveDuration(timeoutMs, "timeout");
  validatePositiveDuration(pollIntervalMs, "poll interval");

  const arrayBuffer =
    blob instanceof ArrayBuffer ? blob : new Uint8Array(blob).buffer;

  // One total time budget covers every phase — upload, transcript creation,
  // and status polling — so a hung request at any hop is aborted instead of
  // leaving the whole operation stuck. 60-second segments transcribe well
  // within the default window; both values are tunable (see
  // AssemblyAITranscriptionArgs) for callers whose segment duration differs.
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const uploadUrl = await uploadAudio(
      apiKey,
      arrayBuffer,
      controller.signal,
      deadline,
      customFetch,
    );
    const transcriptId = await createTranscriptRequest(
      apiKey,
      uploadUrl,
      language,
      controller.signal,
      deadline,
      customFetch,
    );
    const text = await waitForTranscript(
      apiKey,
      transcriptId,
      controller.signal,
      deadline,
      pollIntervalMs,
      customFetch,
    );

    return { text };
  } finally {
    clearTimeout(abortTimer);
  }
};

export const convertFloat32ToPCM16 = (
  float32Array: Float32Array | number[],
): ArrayBuffer => {
  const samples = Array.isArray(float32Array)
    ? float32Array
    : Array.from(float32Array);
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
};
