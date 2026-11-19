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

  it("opens the entry while typing to the assistant, which stops the recording first", () => {
    // This case used to be asserted as `isAgentRecording: true, isAssistantTyping: true` --
    // a combination that cannot occur. `DictationSideEffects` runs `endRecording()` and
    // `invoke("stop_recording")` and only THEN sets `assistantInputMode = "type"`, so the
    // real call is recording-false, typing-true. Asserting the unreachable pair is what let a
    // `!isAgentRecording` early return sit above the typing branch and keep the pill at
    // dictation size for the whole of type mode.
    expect(
      resolvePillWindowSize({
        ...base,
        isAgentRecording: false,
        isAssistantTyping: true,
      }),
    ).toBe("assistant_typing");

    // Kept as a control: recording is the pre-typing state, and it must not regress either.
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
