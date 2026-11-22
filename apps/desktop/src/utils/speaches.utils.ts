import {
  buildTranscriptionFormData,
  throwHttpError,
} from "@maus-inc/utilities";
import { secureFetch as fetch } from "./secure-fetch.utils";

export const SPEACHES_DEFAULT_URL = "http://localhost:8000";
export const SPEACHES_DEFAULT_MODEL = "Systran/faster-whisper-large-v3";

export type SpeachesTestIntegrationArgs = {
  baseUrl?: string;
};

export const speachesTestIntegration = async ({
  baseUrl = SPEACHES_DEFAULT_URL,
}: SpeachesTestIntegrationArgs): Promise<boolean> => {
  const url = baseUrl.replace(/\/$/, "");

  let response: Response;
  try {
    response = await fetch(`${url}/health`);
  } catch (error) {
    // No HTTP response ever arrived, so there is no status to report. This stays
    // a plain error: a statusless failure is still worth another attempt, and a
    // made-up one would be read as a client error that must not be retried.
    throw new Error(
      `Unable to connect to Speaches at ${url}. Make sure Speaches is running. ${error}`,
    );
  }

  if (!response.ok) {
    // The status is carried as data, not as prose, so a retry policy can read a
    // terminal 4xx as terminal and honour a rate-limit hint on a 429 or 503.
    await throwHttpError(response, {
      message: () =>
        `Speaches returned an error (status ${response.status}). Check your configuration.`,
    });
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
  const url = baseUrl.replace(/\/$/, "");

  const formData = buildTranscriptionFormData({
    blob,
    ext,
    model,
    prompt,
    language,
  });

  const response = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
    signal,
  });

  if (!response.ok) {
    await throwHttpError(response, {
      message: (errorText) =>
        `Speaches transcription failed: ${response.status} - ${errorText}`,
    });
  }

  const data = (await response.json()) as { text?: string };

  if (!data.text) {
    // A 2xx body with no text is a malformed payload, not an HTTP failure, so
    // there is no status to report and it stays a plain error.
    throw new Error("Transcription failed: no text in response");
  }

  return { text: data.text };
};
