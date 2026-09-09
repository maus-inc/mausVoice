import { getGenerateTextRepo } from "../repos";
import { getAppState } from "../store";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
} from "../utils/prompt.utils";
import {
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";

export type TonePreviewFields = {
  promptTemplate: string;
  category?: string;
  outputLength?: string;
  exampleInputOutput?: string;
};

export const PREVIEW_SAMPLE_TEXT =
  "i just got back from the store and uh we need milk eggs and bread also can you remind me to call mom tomorrow";

export class TonePreviewNoProviderError extends Error {
  constructor() {
    super("tone-preview-no-provider");
    this.name = "TonePreviewNoProviderError";
  }
}

const unwrapResultJson = (raw: string): string => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed &&
      typeof (parsed as { result: unknown }).result === "string" &&
      (parsed as { result: string }).result.trim()
    ) {
      return (parsed as { result: string }).result.trim();
    }
  } catch {
    // Not JSON: fall through to raw text below.
  }
  return raw.trim();
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
  const input = {
    transcript: sampleText,
    userName: getMyUserName(state),
    dictationLanguage: await loadMyEffectiveDictationLanguage(state),
    tone: {
      kind: "style",
      stylePrompt: fields.promptTemplate,
      category: fields.category,
      outputLength: fields.outputLength,
      exampleInputOutput: fields.exampleInputOutput,
    } as const,
  };

  const output = await repo.generateText({
    system: buildSystemPostProcessingTonePrompt(input),
    prompt: buildPostProcessingPrompt(input),
    signal,
  });
  return unwrapResultJson(output.text);
};
