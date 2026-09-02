import { retry, countWords } from "@maus-inc/utilities";
import type { CustomFetch } from "./types";

export type ElevenLabsTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const elevenlabsTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: ElevenLabsTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch("https://api.elevenlabs.io/v1/user", {
    method: "GET",
    headers: { "xi-api-key": apiKey },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `ElevenLabs responded ${response.status}: ${detail}`
        : `ElevenLabs responded with status ${response.status}`,
    );
  }
  return true;
};

export type ElevenLabsTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  customFetch?: CustomFetch;
};

export type ElevenLabsTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const elevenlabsTranscribeAudio = async ({
  apiKey,
  blob,
  ext,
  language,
  customFetch = fetch,
}: ElevenLabsTranscriptionArgs): Promise<ElevenLabsTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const formData = new FormData();
      const bodyData =
        blob instanceof ArrayBuffer ? blob : (blob.buffer as ArrayBuffer);
      const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
      formData.append("file", audioBlob, `audio.${ext}`);
      formData.append("model_id", "scribe_v2");
      if (language && language !== "auto") {
        formData.append("language_code", language);
      }

      const response = await customFetch(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey.trim(),
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `ElevenLabs API request failed with status ${response.status}: ${errorText}`,
        );
      }

      const data = (await response.json()) as { text?: string };
      const transcript = data?.text;

      if (!transcript) {
        throw new Error(
          "Transcription failed: No text in ElevenLabs API response",
        );
      }

      return { text: transcript, wordsUsed: countWords(transcript) };
    },
  });
};

export { convertFloat32ToBase64PCM16 } from "./audio-convert.utils";
