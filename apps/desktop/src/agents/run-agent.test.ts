import { describe, expect, it, vi } from "vitest";
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
  it("returns the resolved value when the side effect succeeds", async () => {
    const result = await safeSideEffect(
      "label",
      { conversationId: "c-1" },
      async () => "ok",
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
      async () => {
        throw new Error("The resource id 'foo' is invalid");
      },
    );
    expect(result).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(message).toContain("tool-call-result.persist");
    expect(message).toContain("toolCallId=t-1");
  });
});
