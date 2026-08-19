import { secureFetch } from "./secure-fetch.utils";

export type OpenAICompatibleTranscriptionArgs = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  blob: ArrayBuffer;
  ext: string;
  prompt?: string;
  language?: string;
  customFetch?: typeof secureFetch;
};

export type OpenAICompatibleTranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
};

export type OpenAICompatibleTranscribeAudioOutput = {
  text: string;
  segments?: OpenAICompatibleTranscriptionSegment[];
};

export const openaiCompatibleTranscribeAudio = async ({
  baseUrl,
  model,
  apiKey,
  blob,
  ext,
  prompt,
  language,
  customFetch = secureFetch,
}: OpenAICompatibleTranscriptionArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  const url = baseUrl.replace(/\/$/, "");

  // Arbitrary user-configured OpenAI-compatible servers vary widely. We prefer
  // `verbose_json` so capable servers return `segments[].no_speech_prob` and
  // preserve issue #54's probability-gated silence handling. Strict servers
  // that reject `verbose_json` with an unsupported-format 4xx degrade to
  // `json`, then to no `response_format` at all — never repeating the same
  // deterministic 4xx. We never default to `json`, which would silently disable
  // the silence gate for servers that DO support `verbose_json`.
  const buildBody = (format: "verbose_json" | "json" | null): FormData => {
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
    if (format) {
      formData.append("response_format", format);
    }
    return formData;
  };

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const send = (format: "verbose_json" | "json" | null) =>
    customFetch(`${url}/audio/transcriptions`, {
      method: "POST",
      body: buildBody(format),
      headers,
    });

  // A Response body is a single-use stream: read it at most once and pass the
  // text around rather than re-reading after the degradation logic consumes it.
  const readError = async (response: Response): Promise<string> =>
    response.ok ? "" : (await response.text().catch(() => "")).trim();

  const isUnsupportedFormat = (status: number, body: string): boolean =>
    status >= 400 &&
    status < 500 &&
    /response[_\s-]?format|verbose_json|unsupported/i.test(body);

  // Prefer verbose_json (keeps the silence gate); degrade to json, then to no
  // response_format, only on an unsupported-format 4xx.
  let finalResponse = await send("verbose_json");
  let errorBody = await readError(finalResponse);
  if (isUnsupportedFormat(finalResponse.status, errorBody)) {
    finalResponse = await send("json");
    errorBody = await readError(finalResponse);
  }
  if (isUnsupportedFormat(finalResponse.status, errorBody)) {
    finalResponse = await send(null);
    errorBody = await readError(finalResponse);
  }

  if (!finalResponse.ok) {
    throw new Error(
      `OpenAI Compatible transcription failed: ${finalResponse.status} - ${
        errorBody || "Unknown error"
      }`,
    );
  }

  const data = (await finalResponse.json()) as {
    text?: string;
    segments?: Array<{ text?: string; no_speech_prob?: number }>;
  };

  if (!data.text) {
    throw new Error("Transcription failed: no text in response");
  }

  const segments = data.segments
    ? data.segments.map((segment) => ({
        text: segment.text ?? "",
        noSpeechProb: segment.no_speech_prob,
      }))
    : undefined;

  return { text: data.text, segments };
};
