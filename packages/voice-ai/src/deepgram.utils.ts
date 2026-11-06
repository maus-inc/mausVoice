import { HttpError, countWords, retry } from "@maus-inc/utilities";
import { appendQueryParamValues } from "./query-params.utils";
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

    // Every close resolves, not only the three codes that used to be listed.
    //
    // The 5s timeout is cleared here, so a close whose code is not 1008/4001/4003 left the
    // promise pending forever: the card's pending state never cleared and the caller waited
    // on a socket that had already gone. 1000 (a normal close), 1006 (abnormal, no status)
    // and 1011 (server error) are all reachable without `open` or `error` firing first.
    //
    // Resolving unconditionally is safe because a promise settles once: after `onopen` has
    // resolved `true`, a later close resolving `false` changes nothing.
    ws.onclose = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
};

export type DeepgramTranscriptionArgs = {
  apiKey: string;
  model?: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  language?: string;
  /**
   * Keyterm prompting biases recognition toward these terms. nova-3 supports
   * plain terms only (no legacy `keywords` intensifiers), passed by repeating
   * the `keyterm` query parameter.
   */
  keyterms?: string[];
  customFetch?: CustomFetch;
};

export type DeepgramTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const deepgramTranscribeAudio = ({
  apiKey,
  model = "nova-3",
  blob,
  ext,
  language,
  keyterms,
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

      // Keyterm prompting (nova-3): repeat the parameter per term. Weights
      // from the legacy `keywords` feature are silently ignored here, so only
      // plain terms are ever sent.
      appendQueryParamValues(params, "keyterm", keyterms);

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
        throw new HttpError(
          response.status,
          `Deepgram transcription request failed with status ${response.status}: ${errorText}`,
          { retryAfter: response.headers.get("retry-after") },
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
