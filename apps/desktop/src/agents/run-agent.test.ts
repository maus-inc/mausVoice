import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLogBreakingControl } from "@maus-inc/utilities";
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

/** Build a string with control code points via fromCodePoint so the source has
 * no control literals and non-BMP numerics stay well-formed. */
const withControls = (...parts: Array<string | number>): string =>
  parts
    .map((p) => (typeof p === "number" ? String.fromCodePoint(p) : p))
    .join("");

/** True when any log-breaking control remains (shared production predicate). */
const hasLogBreakingControl = (value: string): boolean => {
  for (const ch of value) {
    if (isLogBreakingControl(ch)) return true;
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
    expect(message).toContain('toolCallId="t-1"');
  });

  it("collapses control characters in context values before logging", async () => {
    // LF, TAB, VT, FF, and a C1 control (NEL U+0085) — no control literals in source.
    const snippet = withControls(
      "line1",
      0x0a,
      "line2",
      0x09,
      "line3",
      0x0b,
      0x0c,
      0x85,
      "end",
    );
    await safeSideEffect("label", { snippet }, () =>
      Promise.reject(new Error("boom")),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(hasLogBreakingControl(message)).toBe(false);
    expect(message).toContain('snippet="line1 line2 line3 end"');
  });

  it("JSON-quotes context values so commas and equals stay parseable", async () => {
    await safeSideEffect("label", { note: "a=b, c=d" }, () =>
      Promise.reject(new Error("boom")),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(message).toContain('note="a=b, c=d"');
  });

  it("collapses control characters in the error message before logging", async () => {
    const err = withControls("fail", 0x0a, "secret-line");
    await safeSideEffect("label", { conversationId: "c-1" }, () =>
      Promise.reject(new Error(err)),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(hasLogBreakingControl(message)).toBe(false);
    expect(message).toContain("fail secret-line");
  });

  it("does not truncate a long error message to the 64-char context cap", async () => {
    const err = `resource-id-failure ${"x".repeat(80)}`;
    await safeSideEffect("label", { conversationId: "c-1" }, () =>
      Promise.reject(new Error(err)),
    );
    const message = String(loggerMock.error.mock.calls[0][0]);
    expect(message).toContain(err);
  });
});
