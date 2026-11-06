import { audioToArrayBuffer } from "./audio-convert.utils";
import { retry, countWords } from "@maus-inc/utilities";
import {
  assertProviderIntegrationOk,
  assertPrivateProviderResponseOk,
  parsePrivateProviderJson,
  requestSensitiveTransport,
} from "./provider-response.utils";
import type { CustomFetch } from "./types";

export type ElevenLabsTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const elevenlabsTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: ElevenLabsTestIntegrationArgs): Promise<boolean> => {
  const response = await requestSensitiveTransport(
    "https://api.elevenlabs.io/v1/user",
    { method: "GET", headers: { "xi-api-key": apiKey }, redirect: "error" },
    customFetch,
    "ElevenLabs",
  );
  await assertProviderIntegrationOk(response, "ElevenLabs", [
    apiKey,
    apiKey.trim(),
  ]);
  return true;
};

export type ElevenLabsTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  /**
   * Keyterms bias recognition toward these terms (scribe_v2 supports
   * keyterm prompting). Repeated `keyterms` form fields.
   */
  keyterms?: string[];
  customFetch?: CustomFetch;
  signal?: AbortSignal;
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
  keyterms,
  customFetch = fetch,
  signal,
}: ElevenLabsTranscriptionArgs): Promise<ElevenLabsTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    signal,
    fn: async () => {
      const formData = new FormData();
      const bodyData = audioToArrayBuffer(blob);
      const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
      formData.append("file", audioBlob, `audio.${ext}`);
      formData.append("model_id", "scribe_v2");
      if (language && language !== "auto") {
        formData.append("language_code", language);
      }
      for (const term of keyterms ?? []) {
        const trimmed = term.trim();
        if (trimmed) {
          formData.append("keyterms", trimmed);
        }
      }

      const response = await requestSensitiveTransport(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey.trim(),
          },
          body: formData,
          redirect: "error",
          signal,
        },
        customFetch,
        "ElevenLabs",
      );

      assertPrivateProviderResponseOk(
        response,
        "ElevenLabs API request failed with status",
      );

      const data = (await parsePrivateProviderJson(
        response,
        "ElevenLabs",
        signal,
      )) as {
        text?: string;
      };
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
