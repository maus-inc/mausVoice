import { describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { correctionFeedback } from "./correction-feedback.utils";

describe("correctionFeedback", () => {
  it.each([
    {
      terms: ["Maus"],
      failed: 0,
      suppressed: false,
      message: 'Added "{term}" to your dictionary',
      values: { term: "Maus" },
      mode: "success",
    },
    {
      terms: ["one", "two"],
      failed: 0,
      suppressed: false,
      message: "Added {count} words to your dictionary",
      values: { count: 2 },
      mode: "success",
    },
    {
      terms: ["one"],
      failed: 2,
      suppressed: false,
      message: "Added {added} words to your dictionary ({failed} failed)",
      values: { added: 1, failed: 2 },
      mode: "success",
    },
    {
      terms: [],
      failed: 2,
      suppressed: true,
      message:
        "Transcript updated, but the corrected words could not be added to your dictionary.",
      values: undefined,
      mode: "error",
    },
    {
      terms: [],
      failed: 0,
      suppressed: true,
      message:
        "Transcript updated. Nothing was added to your dictionary because Incognito is on.",
      values: undefined,
      mode: "success",
    },
    {
      terms: [],
      failed: 0,
      suppressed: false,
      message: "Transcript updated",
      values: undefined,
      mode: "success",
    },
  ] as const)(
    "reports $message",
    ({ terms, failed, suppressed, message, values, mode }) => {
      const formatMessage = vi.fn(
        (descriptor: { defaultMessage: string }) => descriptor.defaultMessage,
      );
      const intl = { formatMessage } as unknown as IntlShape;
      expect(
        correctionFeedback(
          {
            learnedTerms: [...terms],
            failedTerms: failed,
            dictionarySuppressed: suppressed,
          },
          intl,
        ),
      ).toEqual({ message, mode });
      expect(formatMessage).toHaveBeenCalledWith(
        { defaultMessage: message },
        ...(values === undefined ? [] : [values]),
      );
    },
  );
});
