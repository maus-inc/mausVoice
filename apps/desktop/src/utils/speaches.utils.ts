import { HttpError } from "@maus-inc/utilities";
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
}: SpeachesTranscriptionArgs): Promise<SpeachesTranscribeAudioOutput> => {
  const url = baseUrl.replace(/\/$/, "");

  const formData = new FormData();
  const file = new Blob([blob], { type: `audio/${ext}` });
  formData.append("file", file, `audio.${ext}`);
  formData.append("model", model);
  if (prompt) {
    formData.append("prompt", prompt);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }

  const response = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    // The status travels on the error as data so the shared retry policy stops
    // on a terminal status and waits out a `Retry-After` hint. The message is
    // unchanged, so callers and the settings snackbar read exactly as before.
    throw new HttpError(
      response.status,
      `Speaches transcription failed: ${response.status} - ${errorText}`,
      { retryAfter: response.headers.get("retry-after") },
    );
  }

  const data = (await response.json()) as { text?: string };

  if (!data.text) {
    // A 2xx body with no text is a malformed payload, not an HTTP failure, so
    // there is no status to report and it stays a plain error.
    throw new Error("Transcription failed: no text in response");
  }

  return { text: data.text };
};
