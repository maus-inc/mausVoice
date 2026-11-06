import { audioToArrayBuffer } from "./audio-convert.utils";
import {
  countWords,
  discardResponseBody,
  readAbortableResponseArrayBuffer,
  retry,
} from "@maus-inc/utilities";
import {
  assertProviderIntegrationOk,
  assertPrivateProviderResponseOk,
  isAbortError,
  parsePrivateProviderJson,
  requestSensitiveTransport,
} from "./provider-response.utils";
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
  const response = await requestSensitiveTransport(
    `${XAI_BASE_URL}/models`,
    {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    },
    customFetch,
    "xAI",
  );

  await assertProviderIntegrationOk(response, "xAI", [apiKey, apiKey.trim()]);
  return true;
};

export type XaiTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
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
  signal,
}: XaiTranscriptionArgs): Promise<XaiTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    signal,
    fn: async () => {
      const formData = new FormData();
      const bodyData = audioToArrayBuffer(blob);
      const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
      // xAI requires a specific language when `format=true`; container audio
      // formats are detected from the uploaded file without this field.
      if (language && language !== "auto") {
        formData.append("format", "true");
        formData.append("language", language);
      }
      // xAI requires the multipart file field to be appended last.
      formData.append("file", audioBlob, `audio.${ext}`);

      const response = await requestSensitiveTransport(
        `${XAI_BASE_URL}/stt`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: formData,
          redirect: "error",
          signal,
        },
        customFetch,
        "xAI",
      );

      assertPrivateProviderResponseOk(
        response,
        "xAI STT request failed with status",
      );

      const data = (await parsePrivateProviderJson(
        response,
        "xAI",
        signal,
      )) as {
        text?: string;
      };
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
  signal?: AbortSignal;
};

export const xaiGenerateSpeech = async ({
  apiKey,
  text,
  voice = "eve",
  language = "en",
  customFetch = fetch,
  signal,
}: XaiSpeakArgs): Promise<ArrayBuffer> => {
  const response = await requestSensitiveTransport(
    `${XAI_BASE_URL}/tts`,
    {
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
      redirect: "error",
      signal,
    },
    customFetch,
    "xAI",
  );

  assertPrivateProviderResponseOk(
    response,
    "xAI TTS request failed with status",
  );

  try {
    return await readAbortableResponseArrayBuffer(response, signal);
  } catch (error) {
    signal?.throwIfAborted();
    discardResponseBody(response);
    if (isAbortError(error)) {
      throw new DOMException("xAI speech response cancelled", "AbortError");
    }
    throw new Error("xAI speech response could not be read");
  }
};
