import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLogBreakingControl } from "@maus-inc/utilities";
import { prepareConversationMessages, safeSideEffect } from "./run-agent";
import type { LlmMessage } from "@maus-inc/types";

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

describe("conversation context preparation", () => {
  const toolExchange = (count: number): LlmMessage[] => {
    const calls = Array.from({ length: count }, (_, i) => ({
      id: `call-${i}`,
      name: "lookup",
      arguments: "{}",
    }));
    return [
      { role: "assistant", content: "latest", toolCalls: calls },
      ...calls.map((call): LlmMessage => ({
        role: "tool",
        toolCallId: call.id,
        content: "ok",
      })),
    ];
  };

  it("preserves an oversized newest complete exchange rather than silently discarding it", () => {
    const initial: LlmMessage = { role: "user", content: "initial" };
    const older: LlmMessage = { role: "assistant", content: "older" };
    const latest = toolExchange(80);
    const actual = prepareConversationMessages([initial, older, ...latest]);
    expect(actual).toEqual([initial, ...latest]);
  });

  it("keeps a complete exchange together and preserves the first user when trimming", () => {
    const initial: LlmMessage = { role: "user", content: "initial" };
    const older: LlmMessage[] = Array.from({ length: 79 }, (_, i) => ({
      role: "assistant",
      content: `older-${i}`,
    }));
    const latest = toolExchange(2);
    const actual = prepareConversationMessages([initial, ...older, ...latest]);
    expect(actual).toHaveLength(80);
    expect(actual[0]).toEqual(initial);
    expect(actual.slice(-3)).toEqual(latest);
  });

  it("drops orphaned results and strips incomplete and duplicate call sets", () => {
    const call = { id: "call", name: "lookup", arguments: "{}" };
    const partial: LlmMessage = {
      role: "assistant",
      content: "partial",
      toolCalls: [call, { ...call, id: "missing" }],
    };
    const duplicate: LlmMessage = {
      role: "assistant",
      content: "duplicate",
      toolCalls: [call, call],
    };
    const result: LlmMessage = {
      role: "tool",
      toolCallId: "call",
      content: "ok",
    };
    expect(
      prepareConversationMessages([result, partial, result, duplicate, result]),
    ).toEqual([
      { role: "assistant", content: "partial" },
      { role: "assistant", content: "duplicate" },
    ]);
  });

  it("accepts complete results in any order and rejects interrupted or repeated results", () => {
    const a = { id: "a", name: "lookup", arguments: "{}" };
    const b = { id: "b", name: "lookup", arguments: "{}" };
    const assistant: LlmMessage = {
      role: "assistant",
      content: "working",
      toolCalls: [a, b],
    };
    const resultA: LlmMessage = { role: "tool", toolCallId: "a", content: "A" };
    const resultB: LlmMessage = { role: "tool", toolCallId: "b", content: "B" };
    const unknown: LlmMessage = {
      role: "tool",
      toolCallId: "other",
      content: "?",
    };
    const user: LlmMessage = { role: "user", content: "next" };
    expect(
      prepareConversationMessages([assistant, resultB, resultA, unknown, user]),
    ).toEqual([assistant, resultB, resultA, user]);
    for (const intervening of [resultA, unknown, user]) {
      const actual = prepareConversationMessages([
        assistant,
        resultA,
        intervening,
        resultB,
      ]);
      expect(actual[0]).toEqual({ role: "assistant", content: "working" });
      expect(actual.filter((item) => item.role === "tool")).toEqual([]);
    }
    expect(
      prepareConversationMessages([
        { role: "assistant", content: "", toolCalls: [] },
      ]),
    ).toEqual([{ role: "assistant", content: undefined }]);
  });
});
