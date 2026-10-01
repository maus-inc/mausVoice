import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { getPostProcessMaxTokens } from "../utils/prompt.utils";

const { generateText, repoAvailable } = vi.hoisted(() => ({
  generateText: vi.fn(async (_input: unknown) => ({ text: "" })),
  repoAvailable: { value: true },
}));

vi.mock("../repos", () => ({
  getGenerateTextRepo: () =>
    repoAvailable.value ? { repo: { generateText } } : { repo: null },
}));

const { intlFormatMessage } = vi.hoisted(() => ({
  /** Every descriptor the code under test asked the intl layer to format. */
  intlFormatMessage: vi.fn(),
}));

// The intl module is wrapped, never stubbed: `getIntl` hands an id-less
// descriptor through as its `defaultMessage`, so the string an action throws is
// the same string whether it was routed through intl or written inline. Only
// the recorded descriptors can tell the two apart.
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

const { applyVoiceEditInstruction } = await import("./composer.actions");

/** The Error a call rejected with, so an assertion can read `error.message`. */
const rejectionOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
};

const LONG_TEXT = "The quarterly review moved to next week. ".repeat(1200);

beforeEach(() => {
  generateText.mockClear();
  intlFormatMessage.mockClear();
  repoAvailable.value = true;
});

describe("composer edit mode", () => {
  it("budgets the rewrite for the transcript instead of the provider default", async () => {
    // Without an explicit budget the provider default decides how much of a
    // long transcript comes back, and the remainder was inserted as truncated
    // text with nothing telling the user it had been cut.
    generateText.mockResolvedValueOnce({ text: "Edited transcript." });

    await applyVoiceEditInstruction({
      text: LONG_TEXT,
      instruction: "Make it shorter.",
    });

    const budget = getPostProcessMaxTokens(LONG_TEXT);
    // The floor is what every short edit also asks for, so a comparison alone
    // would pass with no budget set at all.
    expect(budget).toBeGreaterThan(2048);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: budget }),
    );
  });

  it("asks for a small budget on a short edit too", async () => {
    generateText.mockResolvedValueOnce({ text: "Edited." });

    await applyVoiceEditInstruction({
      text: "hello there",
      instruction: "Shout it.",
    });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: getPostProcessMaxTokens("hello there"),
      }),
    );
  });

  it("reports a missing provider through the intl layer", async () => {
    // `ComposerPage.applyEdit` copies `error.message` into `editError` and
    // renders it as-is, so a sentence written here would ship untranslated.
    repoAvailable.value = false;

    const error = await rejectionOf(
      applyVoiceEditInstruction({
        text: "hello there",
        instruction: "Shout it.",
      }),
    );

    expect(error.message).toBe(
      "Configure a text-generation provider to use Edit Mode.",
    );
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultMessage:
          "Configure a text-generation provider to use Edit Mode.",
      }),
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});
