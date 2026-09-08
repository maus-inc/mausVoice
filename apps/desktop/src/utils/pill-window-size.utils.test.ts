import { describe, expect, it } from "vitest";
import { resolvePillWindowSize } from "./pill-window-size.utils";

const base = {
  hasPendingReview: false,
  isAgentRecording: false,
  isAssistantTyping: false,
  pillHasContent: false,
};

describe("resolvePillWindowSize", () => {
  it("gives a transcript under review the room the assistant entry needs", () => {
    expect(resolvePillWindowSize({ ...base, hasPendingReview: true })).toBe(
      "assistant_typing",
    );
  });

  it("keeps the review size even while the assistant is recording", () => {
    expect(
      resolvePillWindowSize({
        ...base,
        hasPendingReview: true,
        isAgentRecording: true,
        pillHasContent: true,
      }),
    ).toBe("assistant_typing");
  });

  it("uses the dictation size outside an assistant session", () => {
    expect(resolvePillWindowSize(base)).toBe("dictation");
    expect(resolvePillWindowSize({ ...base, pillHasContent: true })).toBe(
      "dictation",
    );
  });

  it("opens the entry while typing to the assistant", () => {
    expect(
      resolvePillWindowSize({
        ...base,
        isAgentRecording: true,
        isAssistantTyping: true,
      }),
    ).toBe("assistant_typing");
  });

  it("expands only once the assistant panel has something to show", () => {
    expect(resolvePillWindowSize({ ...base, isAgentRecording: true })).toBe(
      "assistant_compact",
    );
    expect(
      resolvePillWindowSize({
        ...base,
        isAgentRecording: true,
        pillHasContent: true,
      }),
    ).toBe("assistant_expanded");
  });
});
