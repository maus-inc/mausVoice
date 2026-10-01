import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getPostProcessMaxTokens,
  PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
} from "../utils/prompt.utils";

const { generate } = vi.hoisted(() => ({
  generate: vi.fn(async (_input: unknown) => ({ text: "" })),
}));
vi.mock("../repos", () => ({
  getGenerateTextRepo: () => ({ repo: { generateText: generate } }),
}));
vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  getMyUserName: () => "Tester",
  loadMyEffectiveDictationLanguage: async () => "en",
}));
import {
  MAX_PREVIEW_SAMPLE_LEN,
  previewToneStyle,
  TonePreviewUnusableError,
} from "./tone-preview.actions";

const { intlFormatMessage } = vi.hoisted(() => ({
  /** Every descriptor the code under test asked the intl layer to format. */
  intlFormatMessage: vi.fn(),
}));

// Wrapped, never stubbed. `getIntl` hands an id-less descriptor straight to the
// formatter, so the text a thrown `Error` carries is the same string whether it
// was routed through intl or authored in the action; the recorded descriptors
// are what tell the two apart. `useTonePreview` puts `error.message` on screen.
vi.mock("../i18n/intl", async () => {
  const actual =
    await vi.importActual<typeof import("../i18n/intl")>("../i18n/intl");
  return {
    ...actual,
    getIntl: (...args: Parameters<typeof actual.getIntl>) => {
      const intl = actual.getIntl(...args);
      const realFormatMessage = intl.formatMessage;
      return {
        ...intl,
        formatMessage: (...format: Parameters<IntlShape["formatMessage"]>) => {
          intlFormatMessage(format[0]);
          return realFormatMessage(...format);
        },
      };
    },
  };
});

beforeEach(() => {
  generate.mockReset();
  intlFormatMessage.mockClear();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("style preview provider contract", () => {
  it.each([
    ["a".repeat(8000) + "OVERFLOW", "a".repeat(8000)],
    ["a".repeat(7999) + "😀OVERFLOW", "a".repeat(7999)],
    ["a".repeat(7998) + "😀OVERFLOW", "a".repeat(7998) + "😀"],
  ])(
    "bounds provider input without splitting a surrogate pair (%#)",
    async (sample, bounded) => {
      generate.mockResolvedValueOnce({ text: "styled" });
      await previewToneStyle(
        { promptTemplate: "Be concise." },
        sample,
        new AbortController().signal,
      );
      const { prompt } = generate.mock.calls[0][0] as { prompt: string };
      expect(prompt).toContain(bounded);
      expect(prompt).not.toContain("OVERFLOW");
      expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    },
  );
  it.each([
    ['{"result":"Styled sample"}', "Styled sample"],
    ['```json\n{"result":"Styled sample"}\n```', "Styled sample"],
    ['`{"result":"Styled sample"}`', "Styled sample"],
    ["  Plain provider output  ", "Plain provider output"],
  ])("parses provider output %s", async (text, expected) => {
    generate.mockResolvedValueOnce({ text });
    expect(
      await previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).toBe(expected);
  });

  it("fails loudly when the provider returns nothing usable", async () => {
    // Returning an empty string let the caller mark the preview done, so the
    // user saw a blank box presented as a successful preview, with no
    // explanation at all. A reply that parsed but carried no `edits` key and no
    // `result` text is a failure the dialog has to be able to say something
    // about -- usually a reply truncated at the token limit.
    generate.mockResolvedValueOnce({ text: '{"result":""}' });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TonePreviewUnusableError);
  });

  it("previews the unchanged sample when the provider declares no edits", async () => {
    // Distinct from the case above: an `edits` key that is present but empty is
    // the model saying it changed nothing, so the sample itself is the correct
    // preview. Only a reply with no `edits` key at all is unusable.
    generate.mockResolvedValueOnce({ text: '{"edits":[],"result":""}' });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).resolves.toBe("sample");
  });

  it("still previews a reply that never parsed, shown verbatim", async () => {
    // A style that answers in prose rather than JSON is worth previewing, so
    // this stays a success. Only a reply that parsed into nothing usable fails.
    generate.mockResolvedValueOnce({ text: "Sure, here it is: styled sample" });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).resolves.toBe("Sure, here it is: styled sample");
  });

  it("fails rather than previewing a blank box when the provider answers with whitespace", async () => {
    // `useTonePreview` marks the preview done on any resolved value, so an empty
    // string rendered a blank sample under a successful preview. Whitespace is
    // the same absence of words as an empty reply.
    generate.mockResolvedValueOnce({ text: "   \n\t " });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "TonePreviewUnusableError",
      reason: "empty",
    });
  });

  it("fails when every declared edit failed to match the sample", async () => {
    // The reply declared a change the pipeline could not make, so the text is a
    // valid transcript. Production stores it, but the preview has no fallback:
    // the untouched sample under a green "Preview" would read as the style
    // working when every edit the model asked for was lost.
    generate.mockResolvedValueOnce({
      text: JSON.stringify({
        edits: [{ find: "absent wording", replace: "whatever" }],
        result: "",
      }),
    });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "TonePreviewUnusableError",
      reason: "unreadable-edits",
    });
  });

  it("still previews the partially applied result of a reply that also had misses", async () => {
    // Distinct from the case above: something did change, so the preview shows
    // what the style really did rather than throwing away a usable answer.
    generate.mockResolvedValueOnce({
      text: JSON.stringify({
        edits: [
          { find: "sample", replace: "Styled" },
          { find: "absent wording", replace: "whatever" },
        ],
        result: "",
      }),
    });
    await expect(
      previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).resolves.toBe("Styled");
  });

  it.each(["empty", "unreadable-edits"] as const)(
    "builds the %s failure detail through the intl layer",
    async (reason) => {
      // Both editors render `error.message` verbatim, so prose authored in the
      // action would reach the user in English in every locale.
      const error = new TonePreviewUnusableError(reason);

      expect(error.reason).toBe(reason);
      expect(intlFormatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultMessage:
            reason === "empty"
              ? "The provider returned an empty result, so there is nothing to preview. The style may be asking for something the provider cannot produce for a short sample."
              : "The provider returned edits that could not be applied and no replacement text, so there is nothing to preview. A style that rewrites the whole sample rather than editing it cannot be previewed this way.",
        }),
      );
    },
  );

  it("requests the same response schema as production and forwards cancellation", async () => {
    generate.mockResolvedValueOnce({ text: '{"result":"Styled"}' });
    const controller = new AbortController();
    await previewToneStyle(
      { promptTemplate: "Be concise." },
      "sample",
      controller.signal,
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        maxTokens: 2048,
        reasoningEffort: "low",
        jsonResponse: {
          name: "transcription_cleaning",
          description:
            "JSON response with the edits that clean the transcription, or a full cleaned transcription in result",
          schema: PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
        },
      }),
    );
  });

  it("sizes the output budget from the bounded sample, not the raw input", async () => {
    generate.mockResolvedValueOnce({ text: '{"result":"Styled"}' });
    const sentence = "We moved the launch to next quarter. ";
    const longSample = sentence.repeat(
      Math.ceil((MAX_PREVIEW_SAMPLE_LEN * 4) / sentence.length),
    );
    const boundedBudget = getPostProcessMaxTokens(
      longSample.slice(0, MAX_PREVIEW_SAMPLE_LEN),
    );

    await previewToneStyle(
      { promptTemplate: "Be concise." },
      longSample,
      new AbortController().signal,
    );

    expect(boundedBudget).toBeGreaterThan(2048);
    expect(boundedBudget).toBeLessThan(getPostProcessMaxTokens(longSample));
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: boundedBudget }),
    );
  });
});
