import { getGenerateTextRepo } from "../repos";
import { getAppState } from "../store";
import { resolveProcessedTranscription } from "../utils/ai.utils";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
  type PostProcessingPromptInput,
  PROCESSED_TRANSCRIPTION_JSON_RESPONSE,
  POST_PROCESS_MAX_TOKENS,
} from "../utils/prompt.utils";
import {
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";

// Match the text-field maxLength (UTF-16 code units) and enforce it again at
// the provider boundary for programmatic callers. Do not send half an emoji.
export const MAX_PREVIEW_SAMPLE_LEN = 8000;

const boundPreviewSample = (text: string): string => {
  const end =
    (text.codePointAt(MAX_PREVIEW_SAMPLE_LEN - 1) ?? 0) > 0xffff
      ? MAX_PREVIEW_SAMPLE_LEN - 1
      : MAX_PREVIEW_SAMPLE_LEN;
  return text.slice(0, end);
};

export type TonePreviewFields = {
  promptTemplate: string;
  category?: string;
  outputLength?: string;
  exampleInputOutput?: string;
};

export class TonePreviewNoProviderError extends Error {
  constructor() {
    super("tone-preview-no-provider");
    this.name = "TonePreviewNoProviderError";
  }
}

/**
 * The preview shows the cleaned text when the model produced a usable reply
 * and the model's own words otherwise, so a style that answers in plain text
 * still shows up in the dialog instead of the unedited sample.
 */
const unwrapResultJson = (raw: string, sample: string): string => {
  const resolution = resolveProcessedTranscription(raw, sample);
  if (resolution.status === "cleaned") {
    return resolution.transcript;
  }
  // A reply that never parsed is shown verbatim: a style that answers in prose
  // is still worth previewing. A parsed reply with no text previews as empty.
  return resolution.reason === "unparseable" ? raw.trim() : "";
};

/**
 * Dry-run a style draft through the configured generation provider, using
 * the same system/user prompt builders as production post-processing so the
 * preview shows what the style really does. Throws
 * TonePreviewNoProviderError when no provider is configured; honors the
 * AbortSignal so the dialog can cancel a runaway preview.
 */
export const previewToneStyle = async (
  fields: TonePreviewFields,
  sampleText: string,
  signal: AbortSignal,
): Promise<string> => {
  const { repo } = getGenerateTextRepo();
  if (!repo) {
    throw new TonePreviewNoProviderError();
  }

  const state = getAppState();
  const input: PostProcessingPromptInput = {
    transcript: boundPreviewSample(sampleText),
    userName: getMyUserName(state),
    dictationLanguage: await loadMyEffectiveDictationLanguage(state),
    tone: {
      kind: "style",
      stylePrompt: fields.promptTemplate,
      category: fields.category,
      outputLength: fields.outputLength,
      exampleInputOutput: fields.exampleInputOutput,
    },
    glossary: collectDictionaryEntries(state),
  };

  const output = await repo.generateText({
    system: buildSystemPostProcessingTonePrompt(input),
    prompt: buildPostProcessingPrompt(input),
    signal,
    jsonResponse: PROCESSED_TRANSCRIPTION_JSON_RESPONSE,
    maxTokens: POST_PROCESS_MAX_TOKENS,
  });
  return unwrapResultJson(output.text, input.transcript);
};
