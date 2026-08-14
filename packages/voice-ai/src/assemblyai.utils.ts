import { delayed } from "@maus-inc/utilities";

export type AssemblyAITestIntegrationArgs = {
  apiKey: string;
};

export const assemblyaiTestIntegration = async ({
  apiKey,
}: AssemblyAITestIntegrationArgs): Promise<boolean> => {
  try {
    const response = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "GET",
      headers: { Authorization: apiKey },
    });
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

// Retry only transient failures: network errors, 5xx responses, and 429.
// Other 4xx responses (bad key, invalid request) will not succeed on retry.
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUS_CODES.has(status);

const getBackoffMs = (attempt: number): number =>
  Math.min(100 * 2 ** attempt, 5000);

const getRetryDelayMs = (response: Response, attempt: number): number => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return getBackoffMs(attempt);
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
}: RequestWithRetryOptions): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`${errorLabel}: timed out`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...assemblyaiHeaders(apiKey), ...headers },
        body,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error(`${errorLabel}: timed out`);
      }
      // Network-level failure is transient; retry unless exhausted.
      if (attempt >= maxRetries) {
        throw error;
      }
      await delayed(getBackoffMs(attempt));
      continue;
    }

    if (response.ok) {
      return response;
    }

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`${errorLabel}: ${response.status} - ${errorText}`);
    }

    const retryDelay = getRetryDelayMs(response, attempt);
    await delayed(
      deadline !== undefined
        ? Math.min(retryDelay, Math.max(0, deadline - Date.now()))
        : retryDelay,
    );
  }
};

const uploadAudio = async (
  apiKey: string,
  arrayBuffer: ArrayBuffer,
): Promise<string> => {
  const response = await requestWithRetry({
    apiKey,
    url: `${ASSEMBLYAI_API_URL}/upload`,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: arrayBuffer,
    errorLabel: "AssemblyAI upload failed",
  });

  const { upload_url: uploadUrl } =
    (await response.json()) as AssemblyAIUploadResponse;

  if (!uploadUrl) {
    throw new Error("AssemblyAI upload returned no audio URL");
  }

  return uploadUrl;
};

const createTranscriptRequest = async (
  apiKey: string,
  uploadUrl: string,
  language?: string,
): Promise<string> => {
  const transcriptPayload: Record<string, unknown> = { audio_url: uploadUrl };
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
    errorLabel: "AssemblyAI transcript request failed",
  });

  const created = (await response.json()) as AssemblyAITranscriptResponse;
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
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> => {
  validatePositiveDuration(timeoutMs, "timeout");
  validatePositiveDuration(pollIntervalMs, "poll interval");

  // 60-second segments transcribe well within this window; the deadline only
  // guards against a transcript stuck in "queued"/"processing" or a hung
  // status request. Both values are tunable (see AssemblyAITranscriptionArgs)
  // for callers whose segment duration differs.
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error("AssemblyAI transcription timed out");
      }

      const response = await requestWithRetry({
        apiKey,
        url: `${ASSEMBLYAI_API_URL}/transcript/${transcriptId}`,
        method: "GET",
        errorLabel: "AssemblyAI transcript status failed",
        signal: controller.signal,
        deadline,
      });
      const status = (await response.json()) as AssemblyAITranscriptResponse;

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

      await delayed(
        Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
      );
    }
  } finally {
    clearTimeout(abortTimer);
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
}: AssemblyAITranscriptionArgs): Promise<AssemblyAITranscribeAudioOutput> => {
  const arrayBuffer =
    blob instanceof ArrayBuffer ? blob : new Uint8Array(blob).buffer;

  const uploadUrl = await uploadAudio(apiKey, arrayBuffer);
  const transcriptId = await createTranscriptRequest(
    apiKey,
    uploadUrl,
    language,
  );
  const text = await waitForTranscript(
    apiKey,
    transcriptId,
    timeoutMs,
    pollIntervalMs,
  );

  return { text };
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
