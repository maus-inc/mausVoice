import { getIntl } from "../i18n/intl";
import { getGenerateTextRepo } from "../repos";
import { getAppState } from "../store";
import { resolveProcessedTranscription } from "../utils/ai.utils";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
  type PostProcessingPromptInput,
  PROCESSED_TRANSCRIPTION_JSON_RESPONSE,
  getPostProcessMaxTokens,
  POST_PROCESS_REASONING_EFFORT,
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
 * Why a reply that parsed held nothing to preview. "empty" is a reply with no
 * usable text of any kind; "unreadable-edits" is a reply that declared edits and
 * could not act on any of them.
 */
export type TonePreviewUnusableReason = "empty" | "unreadable-edits";

/**
 * The provider answered, but the answer held no previewable text.
 *
 * A separate error from a transport failure because the two need different
 * words: here the request worked and the model returned something unusable, so
 * retrying is unlikely to help and the style itself may be the problem.
 *
 * The wizard renders a localized "Preview failed." title and this message as the
 * detail, so it carries the explanation. The detail is formatted here rather
 * than written out, because `useTonePreview` puts `message` on screen as-is and
 * a sentence authored in the action would ship untranslated. `reason` is the
 * stable key for a caller that prefers to pick its own localized wording.
 */
export class TonePreviewUnusableError extends Error {
  readonly reason: TonePreviewUnusableReason;

  constructor(reason: TonePreviewUnusableReason) {
    super(
      getIntl().formatMessage(
        reason === "empty"
          ? {
              defaultMessage:
                "The provider returned an empty result, so there is nothing to preview. The style may be asking for something the provider cannot produce for a short sample.",
            }
          : {
              defaultMessage:
                "The provider returned edits that could not be applied and no replacement text, so there is nothing to preview. A style that rewrites the whole sample rather than editing it cannot be previewed this way.",
            },
      ),
    );
    this.name = "TonePreviewUnusableError";
    this.reason = reason;
  }
}

/**
 * The preview shows the cleaned text when the model produced a usable reply
 * and the model's own words otherwise, so a style that answers in plain text
 * still shows up in the dialog instead of the unedited sample.
 *
 * A reply that parsed but yielded nothing usable throws rather than returning
 * an empty string. The caller marks the preview done on any resolved value, so
 * an empty string left the user looking at a blank box labelled as a successful
 * preview, with no indication the style had produced nothing at all.
 */
const unwrapResultJson = (raw: string, sample: string): string => {
  const resolution = resolveProcessedTranscription(raw, sample);
  if (resolution.status === "cleaned") {
    // A reply that declared edits and had none of them applied comes back as
    // "cleaned" with a warning, because the text is a valid transcript and the
    // pipeline has nothing better to store. The preview has no such fallback:
    // showing the untouched sample under a green "Preview" would read as the
    // style working when the model asked for changes that were all lost. The
    // same applies to a reply with no content but whitespace.
    const appliedNothing =
      resolution.warning !== null && resolution.transcript === sample;
    if (appliedNothing) {
      throw new TonePreviewUnusableError("unreadable-edits");
    }
    return resolution.transcript;
  }
  // A reply that never parsed is shown verbatim: a style that answers in prose
  // is still worth previewing. A whitespace-only reply has no words to show, so
  // it is the empty result rather than a preview of nothing.
  if (resolution.reason === "unparseable") {
    const verbatim = raw.trim();
    if (!verbatim) {
      throw new TonePreviewUnusableError("empty");
    }
    return verbatim;
  }
  throw new TonePreviewUnusableError(resolution.reason);
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
  const transcript = boundPreviewSample(sampleText);
  const input: PostProcessingPromptInput = {
    transcript,
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
    maxTokens: getPostProcessMaxTokens(transcript),
    reasoningEffort: POST_PROCESS_REASONING_EFFORT,
  });
  return unwrapResultJson(output.text, input.transcript);
};
