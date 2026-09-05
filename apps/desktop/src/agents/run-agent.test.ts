import { beforeEach, describe, expect, it, vi } from "vitest";
import { codePointOf } from "@maus-inc/utilities";
import { safeSideEffect } from "./run-agent";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

/** Build a string with C0 controls via char codes so the source has no control literals. */
const withControls = (...parts: Array<string | number>): string =>
  parts
    .map((p) => (typeof p === "number" ? String.fromCharCode(p) : p))
    .join("");

/** True when any C0 control or DEL remains (matches sanitizeContextValue's range). */
const hasLogBreakingControl = (value: string): boolean => {
  for (const ch of value) {
    // Same codePointOf helper as production — full Unicode scalar, not a surrogate.
    const code = codePointOf(ch);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

describe("safeSideEffect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the resolved value when the side effect succeeds", async () => {
    const result = await safeSideEffect(
      "label",
      { conversationId: "c-1" },
      () => Promise.resolve("ok"),
    );
    expect(result).toBe("ok");
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("swallows a rejection and returns null so the agent loop survives", async () => {
    // The exact pattern from the user's diagnostics zip: a chat-message
    // persistence call rejects with the platform-level "The resource id
    // is invalid" error. The wrapping must prevent that rejection from
    // escaping the for-await loop and terminating the agent run.
    const result = await safeSideEffect(
      "tool-call-result.persist",
      { conversationId: "c-1", toolCallId: "t-1" },
      () => Promise.reject(new Error("The resource id 'foo' is invalid")),
    );
    expect(result).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(message).toContain("tool-call-result.persist");
    expect(message).toContain("toolCallId=t-1");
  });

  it("collapses control characters in context values before logging", async () => {
    // LF, TAB, VT, FF constructed without embedding control literals in source.
    const snippet = withControls(
      "line1",
      0x0a,
      "line2",
      0x09,
      "line3",
      0x0b,
      0x0c,
    );
    await safeSideEffect("label", { snippet }, () =>
      Promise.reject(new Error("boom")),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(hasLogBreakingControl(message)).toBe(false);
    expect(message).toContain("snippet=line1 line2 line3");
  });
});
