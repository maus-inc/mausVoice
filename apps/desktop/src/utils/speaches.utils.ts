import { discardResponseBody, HttpError } from "@maus-inc/utilities";
import { readSpeachesTranscription, requestSpeaches } from "@maus-inc/voice-ai";
import { secureFetch as fetch } from "./secure-fetch.utils";
import { buildTranscriptionForm } from "./transcription-form.utils";

const SPEACHES_DEFAULT_URL = "http://localhost:8000";

export type SpeachesTestIntegrationArgs = {
  baseUrl?: string;
};

export const speachesTestIntegration = async ({
  baseUrl = SPEACHES_DEFAULT_URL,
}: SpeachesTestIntegrationArgs): Promise<boolean> => {
  const url = baseUrl.replace(/\/$/, "");

  const response = await requestSpeaches(`${url}/health`, undefined, fetch);
  discardResponseBody(response);

  if (!response.ok) {
    // The status is carried as data, not as prose, so a retry policy can read a
    // terminal 4xx as terminal and honour a rate-limit hint on a 429 or 503.
    throw new HttpError(
      response.status,
      `Speaches returned an error (status ${response.status}). Check your configuration.`,
      { retryAfter: response.headers.get("retry-after") },
    );
  }

  return true;
};

export type SpeachesTranscriptionArgs = {
  baseUrl: string;
  model: string;
  blob: ArrayBuffer;
  ext: string;
  prompt?: string;
  language?: string;
  signal?: AbortSignal;
};

export type SpeachesTranscribeAudioOutput = {
  text: string;
};

export const speachesTranscribeAudio = async ({
  baseUrl,
  model,
  blob,
  ext,
  prompt,
  language,
  signal,
}: SpeachesTranscriptionArgs): Promise<SpeachesTranscribeAudioOutput> => {
  signal?.throwIfAborted();
  const url = baseUrl.replace(/\/$/, "");

  const formData = buildTranscriptionForm({
    blob,
    ext,
    model,
    prompt,
    language,
  });

  const response = await requestSpeaches(
    `${url}/v1/audio/transcriptions`,
    { method: "POST", body: formData, signal },
    fetch,
  );

  return { text: await readSpeachesTranscription(response, signal) };
};
