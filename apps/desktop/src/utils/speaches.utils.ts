import { fetch } from "@tauri-apps/plugin-http";
import { postTranscriptionRequest } from "@maus-inc/voice-ai";

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
    throw new Error(
      `Unable to connect to Speaches at ${url}. Make sure Speaches is running. ${error}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Speaches returned an error (status ${response.status}). Check your configuration.`,
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
  const text = await postTranscriptionRequest({
    url: `${url}/v1/audio/transcriptions`,
    blob,
    ext,
    model,
    prompt,
    language,
    label: "Speaches",
    fetchImpl: fetch,
  });
  return { text };
};
