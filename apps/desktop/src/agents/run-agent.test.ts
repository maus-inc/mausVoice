import { beforeEach, describe, expect, it, vi } from "vitest";
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
    await safeSideEffect(
      "label",
      { snippet: "line1\nline2\tline3\u000b\u000c" },
      () => Promise.reject(new Error("boom")),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(message).not.toMatch(/[\n\r\t\u000b\u000c]/);
    expect(message).toContain("snippet=line1 line2 line3");
  });
});
