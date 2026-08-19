import { countWords, retry } from "@maus-inc/utilities";
import type { CustomFetch } from "./types";

const XAI_BASE_URL = "https://api.x.ai/v1";

export const XAI_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];

export type XaiTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const xaiTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: XaiTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${XAI_BASE_URL}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `xAI responded ${response.status}: ${detail}`
        : `xAI responded with status ${response.status}`,
    );
  }
  return true;
};

export type XaiTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  customFetch?: CustomFetch;
};

export type XaiTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const xaiTranscribeAudio = async ({
  apiKey,
  blob,
  ext,
  language,
  customFetch = fetch,
}: XaiTranscriptionArgs): Promise<XaiTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const formData = new FormData();
      const bodyData =
        blob instanceof ArrayBuffer ? blob : (blob.buffer as ArrayBuffer);
      const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
      // xAI's STT API expects the audio format as the `format` value (e.g.
      // "wav", "mp3", "flac"), not the literal string "true". Using the actual
      // extension from the file being transcribed gives the API the information
      // it needs to decode the audio correctly.
      formData.append("format", ext);
      if (language && language !== "auto") {
        formData.append("language", language);
      }
      // xAI requires the multipart file field to be appended last.
      formData.append("file", audioBlob, `audio.${ext}`);

      const response = await customFetch(`${XAI_BASE_URL}/stt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `xAI STT request failed with status ${response.status}: ${errorText}`,
        );
      }

      const data = (await response.json()) as { text?: string };
      const transcript = data?.text;

      if (!transcript) {
        throw new Error("Transcription failed: No text in xAI STT response");
      }

      return { text: transcript, wordsUsed: countWords(transcript) };
    },
  });
};

export type XaiSpeakArgs = {
  apiKey: string;
  text: string;
  voice?: XaiTtsVoice;
  language?: string;
  customFetch?: CustomFetch;
};

export const xaiGenerateSpeech = async ({
  apiKey,
  text,
  voice = "eve",
  language = "en",
  customFetch = fetch,
}: XaiSpeakArgs): Promise<ArrayBuffer> => {
  const response = await customFetch(`${XAI_BASE_URL}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voice,
      language,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `xAI TTS request failed with status ${response.status}: ${errorText}`,
    );
  }

  return response.arrayBuffer();
};
