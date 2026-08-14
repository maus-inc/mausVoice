import { delayed, retry } from "@maus-inc/utilities";

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

const uploadAudio = async (
  apiKey: string,
  arrayBuffer: ArrayBuffer,
): Promise<string> => {
  const { upload_url: uploadUrl } = await retry({
    retries: 3,
    fn: async () => {
      const response = await fetch(`${ASSEMBLYAI_API_URL}/upload`, {
        method: "POST",
        headers: {
          ...assemblyaiHeaders(apiKey),
          "Content-Type": "application/octet-stream",
        },
        body: arrayBuffer,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `AssemblyAI upload failed: ${response.status} - ${errorText}`,
        );
      }

      return (await response.json()) as AssemblyAIUploadResponse;
    },
  });

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

  const created = await retry({
    retries: 3,
    fn: async () => {
      const response = await fetch(`${ASSEMBLYAI_API_URL}/transcript`, {
        method: "POST",
        headers: {
          ...assemblyaiHeaders(apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(transcriptPayload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `AssemblyAI transcript request failed: ${response.status} - ${errorText}`,
        );
      }

      return (await response.json()) as AssemblyAITranscriptResponse;
    },
  });

  const transcriptId = created.id;
  if (!transcriptId) {
    throw new Error("AssemblyAI transcript request returned no ID");
  }

  return transcriptId;
};

const waitForTranscript = async (
  apiKey: string,
  transcriptId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> => {
  // 60-second segments transcribe well within this window; the deadline
  // only guards against a transcript stuck in "queued"/"processing". Both
  // values are tunable (see AssemblyAITranscriptionArgs) for callers whose
  // segment duration differs.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await retry({
      retries: 3,
      fn: async () => {
        const response = await fetch(
          `${ASSEMBLYAI_API_URL}/transcript/${transcriptId}`,
          {
            method: "GET",
            headers: assemblyaiHeaders(apiKey),
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new Error(
            `AssemblyAI transcript status failed: ${response.status} - ${errorText}`,
          );
        }

        return (await response.json()) as AssemblyAITranscriptResponse;
      },
    });

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

    if (Date.now() > deadline) {
      throw new Error("AssemblyAI transcription timed out");
    }

    await delayed(pollIntervalMs);
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
