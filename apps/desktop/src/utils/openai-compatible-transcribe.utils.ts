import { fetch } from "@tauri-apps/plugin-http";
import {
  buildOpenAICompatibleTranscriptionUrl,
  OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH,
} from "./openai-compatible.utils";

export type OpenAICompatibleTranscriptionArgs = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  blob: ArrayBuffer;
  ext: string;
  prompt?: string;
  language?: string;
  transcriptionPath?: string;
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
  transcriptionPath,
}: OpenAICompatibleTranscriptionArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  const url = buildOpenAICompatibleTranscriptionUrl(
    baseUrl,
    false,
    transcriptionPath ?? OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH,
  );

  const formData = new FormData();
  const file = new Blob([blob], { type: `audio/${ext}` });
  formData.append("file", file, `audio.${ext}`);
  formData.append("model", model);
  if (prompt) {
    formData.append("prompt", prompt);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI Compatible transcription failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { text?: string };

  if (!data.text) {
    throw new Error("Transcription failed: no text in response");
  }

  return { text: data.text };
};
