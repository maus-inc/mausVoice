import { describe, expect, it } from "vitest";
import { POST_PROCESS_ERROR_CATEGORY } from "./post-process-error-category";
import {
  getFastStyleTruncationMessage,
  getPostProcessFeedback,
  getPostProcessFeedbackToastAction,
  type PostProcessFeedbackMetadata,
} from "./post-process-feedback";

describe("getPostProcessFeedbackToastAction", () => {
  it.each([
    ["fix", "open_post_processing_settings"],
    ["history", "open_transcriptions"],
  ] as const)(
    "maps %s to its native toast action",
    (feedbackAction, toastAction) => {
      expect(getPostProcessFeedbackToastAction(feedbackAction)).toBe(
        toastAction,
      );
    },
  );
});

describe("getPostProcessFeedback", () => {
  it("explains the provider cause when local styling succeeds and offers Fix", () => {
    expect(
      getPostProcessFeedback(
        {
          postProcessFailed: false,
          postProcessFallback: true,
          postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
        },
        "dictation",
      ),
    ).toEqual({
      kind: "local-fallback",
      severity: "info",
      message:
        "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead.",
      action: "fix",
    });
  });

  it("explains a complete failure and offers History without claiming quota expiry", () => {
    const feedback = getPostProcessFeedback(
      {
        postProcessFailed: true,
        postProcessFallback: false,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
      "dictation",
    );

    expect(feedback).toEqual({
      kind: "failed",
      severity: "error",
      message:
        "Styling failed because the provider request or usage limit was reached. The raw transcript is saved in History.",
      action: "history",
    });
    expect(feedback?.message).not.toContain("expired");
  });

  it("uses a safe default reason when a failure has no stored category", () => {
    expect(
      getPostProcessFeedback(
        { postProcessFailed: true, postProcessError: null },
        "dictation",
      )?.message,
    ).toBe(
      "Styling failed because the post-processing provider returned an error. The raw transcript is saved in History.",
    );
  });

  it("does not claim History when dictation could not be saved", () => {
    const feedback = getPostProcessFeedback(
      {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
      "dictation",
      { canRecoverFromHistory: false },
    );

    expect(feedback).toMatchObject({
      kind: "failed",
      severity: "error",
      message:
        "Styling failed because the provider request or usage limit was reached. The app did not insert the transcript or save it in History.",
      action: undefined,
    });
  });

  it("keeps the details reason neutral about whether this run was persisted", () => {
    expect(
      getPostProcessFeedback(
        {
          postProcessFailed: true,
          postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
        },
        "history-details",
      )?.message,
    ).toBe(
      "Styling failed because the provider request or usage limit was reached.",
    );
  });

  it("reports an unusable online reply without claiming insertion", () => {
    const feedback = getPostProcessFeedback(
      { postProcessFallback: true, postProcessError: null },
      "dictation",
    );

    expect(feedback).toEqual({
      kind: "unusable-response",
      severity: "info",
      message: "Online styling could not be used for this dictation.",
    });
    expect(feedback?.message).not.toContain("local style");
  });

  const quietOutcomes: [string, PostProcessFeedbackMetadata][] = [
    ["expected local styling", { postProcessMode: "fast" }],
    ["normal online success", { postProcessFailed: false }],
  ];

  it.each(quietOutcomes)("stays quiet for %s", (_label, metadata) => {
    expect(getPostProcessFeedback(metadata, "dictation")).toBeNull();
  });

  it("does not claim an unusable raw transcript was saved when persistence is disabled", () => {
    expect(
      getPostProcessFeedback(
        { postProcessFallback: true },
        "history-retranscription",
        {
          hasPreviousTranscript: false,
          unusableResponseType: "truncated",
          canRecoverFromHistory: false,
        },
      )?.message,
    ).toBe(
      "The provider reply was unusable. The raw transcript is available in this session, but it was not saved in History.",
    );
  });

  it("keeps a prior History transcript when a retranscription reply is unusable", () => {
    expect(
      getPostProcessFeedback(
        { postProcessFallback: true },
        "history-retranscription",
        {
          hasPreviousTranscript: true,
          unusableResponseType: "unreadable",
        },
      )?.message,
    ).toBe(
      "The unreadable styling reply was discarded, leaving the previous text in place.",
    );
  });
});

describe("getFastStyleTruncationMessage", () => {
  it("points to History for a truncated dictation", () => {
    expect(
      getFastStyleTruncationMessage(42, {
        canRecoverFromHistory: true,
        context: "dictation",
      }),
    ).toBe(
      "Fast styling left the last 42 characters of that dictation unstyled. The unstyled ending is in History.",
    );
  });

  it("uses audio wording for imports and retranscriptions", () => {
    expect(
      getFastStyleTruncationMessage(42, {
        canRecoverFromHistory: true,
        context: "audio",
      }),
    ).toBe(
      "Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.",
    );
  });

  it("does not promise History when persistence is disabled", () => {
    expect(
      getFastStyleTruncationMessage(42, {
        canRecoverFromHistory: false,
        context: "audio",
      }),
    ).toBe(
      "Fast styling left the last 42 characters unstyled. The app did not save them in History.",
    );
  });

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "stays quiet for invalid or empty truncation metadata (%s)",
    (droppedChars) => {
      expect(
        getFastStyleTruncationMessage(droppedChars, {
          canRecoverFromHistory: true,
          context: "audio",
        }),
      ).toBeNull();
    },
  );
});
