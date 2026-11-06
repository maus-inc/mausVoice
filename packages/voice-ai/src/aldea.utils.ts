import { audioToArrayBuffer } from "./audio-convert.utils";
import { retry, countWords } from "@maus-inc/utilities";
import {
  assertPrivateProviderResponseOk,
  parsePrivateProviderJson,
  requestPrivateTransport,
} from "./provider-response.utils";

const ALDEA_API_URL = "https://api.aldea.ai/v1/listen";

/** Do not expose transport failures that may contain private request fragments. */
const requestAldea = (url: string, init: RequestInit): Promise<Response> =>
  requestPrivateTransport(
    url,
    init,
    globalThis.fetch,
    "Aldea",
    "Unable to connect to Aldea",
  );

export type AldeaTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  ext?: string;
  language?: string;
  signal?: AbortSignal;
};

export type AldeaTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

type AldeaResponse = {
  metadata?: {
    channels?: number;
    duration?: number;
    request_id?: string;
  };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        confidence?: number;
        transcript?: string;
        words?: unknown[];
      }>;
    }>;
  };
};

export const aldeaTranscribeAudio = async ({
  apiKey,
  blob,
  language,
  signal,
}: AldeaTranscriptionArgs): Promise<AldeaTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    signal,
    isRetryable: () => !signal?.aborted,
    fn: async () => {
      signal?.throwIfAborted();
      const bodyData = audioToArrayBuffer(blob);
      const url = new URL(ALDEA_API_URL);
      if (language && language !== "auto") {
        url.searchParams.set("language", language);
      }
      const response = await requestAldea(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: bodyData,
        // A 307/308 redirect can otherwise forward the private audio body to
        // a different origin even if fetch strips the Authorization header.
        redirect: "error",
        signal,
      });

      assertPrivateProviderResponseOk(
        response,
        "Aldea API request failed with status",
      );

      const data = await parsePrivateProviderJson<AldeaResponse>(
        response,
        "Aldea",
        signal,
      );

      const transcript =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

      if (!transcript) {
        throw new Error(
          "Transcription failed: No transcript in Aldea API response",
        );
      }

      return { text: transcript, wordsUsed: countWords(transcript) };
    },
  });
};

export type AldeaTestIntegrationArgs = {
  apiKey: string;
};

export const aldeaTestIntegration = async ({
  apiKey,
}: AldeaTestIntegrationArgs): Promise<boolean> => {
  try {
    const response = await requestAldea(ALDEA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: new ArrayBuffer(0),
      redirect: "error",
    });

    return response.ok || response.status === 400;
  } catch {
    throw new Error("Aldea integration test failed: unable to connect");
  }
};
