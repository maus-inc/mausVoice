import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@maus-inc/types";
import {
  isValidPersistedToolCall,
  toReplayMessage,
} from "./conversation-replay";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "m",
  conversationId: "c",
  role: "user",
  content: "hello",
  createdAt: "2026-01-01",
  metadata: null,
  ...overrides,
});

describe("persisted conversation replay", () => {
  it("restores tool results before considering the stored role", () => {
    expect(
      toReplayMessage(
        message({
          role: "system",
          metadata: { type: "tool-result", toolCallId: "call" },
        }),
      ),
    ).toEqual({ role: "tool", toolCallId: "call", content: "hello" });
    expect(
      toReplayMessage(
        message({
          role: "system",
          metadata: { type: "tool-result", toolCallId: 7 },
        }),
      ),
    ).toBeNull();
  });

  it("restores users and valid assistant calls, and drops malformed calls", () => {
    expect(toReplayMessage(message({}))).toEqual({
      role: "user",
      content: "hello",
    });
    const calls = [{ id: "call", name: "lookup", arguments: "{}" }];
    expect(
      toReplayMessage(
        message({
          role: "assistant",
          content: "",
          metadata: { toolCalls: calls },
        }),
      ),
    ).toEqual({ role: "assistant", content: undefined, toolCalls: calls });
    expect(
      toReplayMessage(
        message({
          role: "assistant",
          metadata: {
            toolCalls: [calls[0], { id: "", name: "bad", arguments: "{}" }],
          },
        }),
      ),
    ).toEqual({ role: "assistant", content: "hello" });
  });

  it.each([
    null,
    0,
    {},
    { id: "a", name: "b", arguments: null },
    { id: "a", name: "", arguments: "{}" },
  ])("rejects invalid tool calls", (value) => {
    expect(isValidPersistedToolCall(value)).toBe(false);
  });
});
