import {
  countWords,
  discardResponseBody,
  readAbortableResponseJson,
  retry,
} from "@maus-inc/utilities";
import { audioToArrayBuffer } from "./audio-convert.utils";
import {
  assertPrivateProviderResponseOk,
  requestPrivateTransport,
} from "./provider-response.utils";

/** Keep transport failures from echoing configured URLs or private request data. */
export const requestSpeaches = async (
  url: string,
  init?: RequestInit,
  transport: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> => {
  return requestPrivateTransport(
    url,
    // A redirect may replay private audio or prompt text to another origin.
    { ...init, redirect: "error" },
    transport,
    "Speaches",
    "Unable to connect to Speaches. Make sure Speaches is running.",
  );
};

export type SpeachesTestIntegrationArgs = {
  baseUrl: string;
};

export const speachesTestIntegration = async ({
  baseUrl,
}: SpeachesTestIntegrationArgs): Promise<boolean> => {
  const url = baseUrl.replace(/\/$/, "");
  const response = await requestSpeaches(`${url}/health`);
  discardResponseBody(response);
  return response.ok;
};

export type SpeachesTranscriptionArgs = {
  baseUrl: string;
  model: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type SpeachesTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

/** Parse a Speaches response consistently for local and hosted transports. */
export const readSpeachesTranscription = async (
  response: Response,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted) {
    discardResponseBody(response);
    signal.throwIfAborted();
  }
  // A transcription service can echo arbitrary fragments of private speech or
  // prompt text in its error body; exact-secret redaction cannot identify them.
  assertPrivateProviderResponseOk(response, "Speaches transcription failed:");

  let data: { text?: unknown } | null;
  try {
    data = await readAbortableResponseJson<{ text?: unknown } | null>(
      response,
      signal,
    );
  } catch {
    // JSON parser errors can quote a fragment of the returned transcript.
    signal?.throwIfAborted();
    throw new Error("Transcription failed: invalid response");
  }
  if (typeof data?.text !== "string" || !data.text) {
    throw new Error("Transcription failed: no text in response");
  }
  return data.text;
};

export const speachesTranscribeAudio = ({
  baseUrl,
  model,
  blob,
  ext,
  prompt,
  language,
}: SpeachesTranscriptionArgs): Promise<SpeachesTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const formData = new FormData();
      const arrayBuffer = audioToArrayBuffer(blob);
      const file = new Blob([arrayBuffer], { type: `audio/${ext}` });
      formData.append("file", file, `audio.${ext}`);
      formData.append("model", model);
      if (prompt) {
        formData.append("prompt", prompt);
      }
      if (language) {
        formData.append("language", language);
      }

      const url = baseUrl.replace(/\/$/, "");
      const response = await requestSpeaches(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      const text = await readSpeachesTranscription(response);
      return { text, wordsUsed: countWords(text) };
    },
  });
};
