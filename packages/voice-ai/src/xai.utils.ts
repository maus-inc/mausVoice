import { countWords, retry, throwHttpError } from "@maus-inc/utilities";
import { probeProviderEndpoint } from "./provider-probe.utils";
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
  customFetch,
}: XaiTestIntegrationArgs): Promise<boolean> =>
  probeProviderEndpoint({
    label: "xAI",
    url: `${XAI_BASE_URL}/models`,
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    },
    customFetch,
  });

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

export const xaiTranscribeAudio = ({
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
      // xAI requires a specific language when `format=true`; container audio
      // formats are detected from the uploaded file without this field.
      if (language && language !== "auto") {
        formData.append("format", "true");
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
        await throwHttpError(response, {
          message: (errorText) =>
            `xAI STT request failed with status ${response.status}: ${errorText}`,
        });
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
    await throwHttpError(response, {
      message: (errorText) =>
        `xAI TTS request failed with status ${response.status}: ${errorText}`,
    });
  }

  return response.arrayBuffer();
};
