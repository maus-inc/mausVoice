import { countWords, retry } from "@maus-inc/utilities";
import type { CustomFetch } from "./types";

export type DeepgramTestIntegrationArgs = {
  apiKey: string;
};

export const DEEPGRAM_TRANSCRIPTION_MODELS = ["nova-3"] as const;
export type DeepgramTranscriptionModel =
  (typeof DEEPGRAM_TRANSCRIPTION_MODELS)[number];

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

export const deepgramTestIntegration = ({
  apiKey,
}: DeepgramTestIntegrationArgs): Promise<boolean> => {
  return new Promise((resolve) => {
    const wsUrl =
      "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&model=nova-3";
    const ws = new WebSocket(wsUrl, ["token", apiKey]);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };

    ws.onclose = (event) => {
      clearTimeout(timeout);
      if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
        resolve(false);
      }
    };
  });
};

export type DeepgramTranscriptionArgs = {
  apiKey: string;
  model?: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  customFetch?: CustomFetch;
};

export type DeepgramTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const deepgramTranscribeAudio = async ({
  apiKey,
  model = "nova-3",
  blob,
  ext,
  language,
  customFetch = fetch,
}: DeepgramTranscriptionArgs): Promise<DeepgramTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const params = new URLSearchParams({
        model,
        punctuate: "true",
        smart_format: "true",
      });

      if (language && language !== "auto") {
        params.set("language", language);
      } else {
        params.set("detect_language", "true");
      }

      const response = await customFetch(
        `${DEEPGRAM_LISTEN_URL}?${params.toString()}`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey.trim()}`,
            "Content-Type": `audio/${ext}`,
          },
          body:
            blob instanceof ArrayBuffer ? blob : (blob.buffer as ArrayBuffer),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Deepgram transcription request failed with status ${response.status}: ${errorText}`,
        );
      }

      const data = (await response.json()) as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{
              transcript?: string;
            }>;
          }>;
        };
      };
      const transcript =
        data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ??
        "";

      if (!transcript) {
        throw new Error("Transcription failed: No text in Deepgram response");
      }

      return {
        text: transcript,
        wordsUsed: countWords(transcript),
      };
    },
  });
};
