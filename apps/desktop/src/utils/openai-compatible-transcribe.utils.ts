import { fetch } from "@tauri-apps/plugin-http";
import { postTranscriptionRequest } from "@maus-inc/voice-ai";

export type OpenAICompatibleTranscriptionArgs = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  blob: ArrayBuffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type OpenAICompatibleTranscribeAudioOutput = {
  text: string;
};

export const openaiCompatibleTranscribeAudio = async ({
  baseUrl,
  model,
  apiKey,
  blob,
  ext,
  prompt,
  language,
}: OpenAICompatibleTranscriptionArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  const url = baseUrl.replace(/\/$/, "");
  const text = await postTranscriptionRequest({
    url: `${url}/audio/transcriptions`,
    blob,
    ext,
    model,
    prompt,
    language,
    apiKey,
    label: "OpenAI Compatible",
    fetchImpl: fetch,
  });
  return { text };
};
