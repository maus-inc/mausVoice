import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolPermission } from "@maus-inc/types";
import { partsForMessage, persistedRunOutcomeOf } from "./chat-parts.utils";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  conversationId: "c1",
  role: "assistant",
  content: "",
  createdAt: "2026-09-10T00:00:00.000Z",
  metadata: null,
  ...overrides,
});

const permission = (
  overrides: Partial<ToolPermission> = {},
): ToolPermission => ({
  id: "p1",
  toolId: "paste",
  params: {},
  status: "pending",
  conversationId: "c1",
  createdAt: 0,
  ...overrides,
});

describe("partsForMessage", () => {
  it("reads a plain user message as one text part", () => {
    expect(
      partsForMessage({
        message: message({ role: "user", content: "hello" }),
      }),
    ).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("reads a legacy tool-result row as a tool-result part", () => {
    const parts = partsForMessage({
      message: message({
        role: "system",
        content: "pasted",
        metadata: {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "paste",
          reason: "the user asked",
        },
      }),
    });
    expect(parts).toEqual([
      {
        kind: "tool-result",
        toolCallId: "tc1",
        toolName: "paste",
        reason: "the user asked",
      },
    ]);
  });

  it("falls back to the message id when the tool call id is missing", () => {
    const parts = partsForMessage({
      message: message({
        role: "system",
        content: "pasted",
        metadata: { type: "tool-result", toolName: "paste" },
      }),
    });
    expect(parts[0]).toMatchObject({ kind: "tool-result", toolCallId: "m1" });
  });

  it("does not invent successful outcomes for legacy reasoning metadata", () => {
    const parts = partsForMessage({
      message: message({
        content: "done writing",
        metadata: {
          type: "reasoning",
          toolCalls: [
            { id: "tc1", name: "paste", arguments: "{}" },
            { id: "tc2", name: "speak", arguments: "{}" },
          ],
        },
      }),
    });
    expect(parts).toEqual([
      {
        kind: "tool",
        toolCallId: "tc1",
        toolName: "paste",
        status: "unknown",
      },
      {
        kind: "tool",
        toolCallId: "tc2",
        toolName: "speak",
        status: "unknown",
      },
      { kind: "text", text: "done writing" },
    ]);
  });

  it("marks a step denied and skips its prompt once decided", () => {
    const parts = partsForMessage({
      message: message({
        metadata: {
          type: "reasoning",
          toolCalls: [{ id: "tc1", name: "paste", arguments: "{}" }],
        },
      }),
      permissions: [permission({ toolCallId: "tc1", status: "denied" })],
    });
    expect(parts).toEqual([
      { kind: "tool", toolCallId: "tc1", toolName: "paste", status: "denied" },
    ]);
  });

  it("attaches a pending prompt to its step", () => {
    const parts = partsForMessage({
      message: message({
        metadata: {
          type: "reasoning",
          toolCalls: [{ id: "tc1", name: "paste", arguments: "{}" }],
        },
      }),
      permissions: [
        permission({
          id: "p9",
          toolCallId: "tc1",
          params: { reason: "paste it" },
        }),
      ],
    });
    expect(parts).toEqual([
      {
        kind: "tool",
        toolCallId: "tc1",
        toolName: "paste",
        status: "approval",
        reason: "paste it",
      },
      { kind: "permission", permissionId: "p9" },
    ]);
  });

  it("ignores malformed persisted tool calls", () => {
    const parts = partsForMessage({
      message: message({
        content: "text survives",
        metadata: { type: "reasoning", toolCalls: [{ nope: 1 }, null, "x"] },
      }),
    });
    expect(parts).toEqual([{ kind: "text", text: "text survives" }]);
  });

  it("prefers the live overlay over persisted steps on the streaming message", () => {
    const parts = partsForMessage({
      message: message({
        content: "partial",
        metadata: {
          type: "reasoning",
          toolCalls: [{ id: "tc0", name: "old", arguments: "{}" }],
        },
      }),
      streaming: { toolCalls: [], reasoning: "", isStreaming: true },
      liveToolCalls: [
        {
          toolCallId: "tc1",
          toolName: "paste",
          params: {},
          status: "awaiting-permission",
          permissionId: "p1",
        },
      ],
      permissions: [permission({ id: "p1", toolCallId: "tc1" })],
    });
    expect(parts).toEqual([
      {
        kind: "tool",
        toolCallId: "tc1",
        toolName: "paste",
        status: "approval",
      },
      { kind: "permission", permissionId: "p1" },
      { kind: "text", text: "partial" },
    ]);
  });

  it("maps every live agent status", () => {
    const parts = partsForMessage({
      message: message({ content: "" }),
      streaming: { toolCalls: [], reasoning: "", isStreaming: true },
      liveToolCalls: [
        { toolCallId: "a", toolName: "t", params: {}, status: "pending" },
        { toolCallId: "b", toolName: "t", params: {}, status: "executing" },
        { toolCallId: "c", toolName: "t", params: {}, status: "done" },
        { toolCallId: "d", toolName: "t", params: {}, status: "denied" },
      ],
    });
    expect(parts.map((p) => (p.kind === "tool" ? p.status : p.kind))).toEqual([
      "pending",
      "running",
      "complete",
      "denied",
    ]);
  });

  it("shows live reasoning while streaming", () => {
    const parts = partsForMessage({
      message: message({ content: "" }),
      streaming: { toolCalls: [], reasoning: "hmm", isStreaming: true },
    });
    expect(parts).toEqual([{ kind: "reasoning", text: "hmm", open: true }]);
  });

  it("appends a run note trailer", () => {
    const parts = partsForMessage({
      message: message({ role: "user", content: "go" }),
      runNote: { kind: "error", text: "The run failed." },
    });
    expect(parts).toEqual([
      { kind: "text", text: "go" },
      { kind: "error", text: "The run failed." },
    ]);
  });

  it("returns nothing for an empty assistant stub with no activity", () => {
    expect(partsForMessage({ message: message() })).toEqual([]);
  });
  it.each(["complete", "failed", "denied", "unknown"] as const)(
    "uses stored %s status instead of a stale permission with the same tool id",
    (status) => {
      const parts = partsForMessage({
        message: message({
          metadata: {
            type: "reasoning",
            toolCalls: [{ id: "call", name: "paste", arguments: "{}" }],
            toolStatuses: { call: status },
          },
        }),
        permissions: [permission({ toolCallId: "call", status: "allowed" })],
      });
      expect(parts[0]).toMatchObject({ kind: "tool", status });
    },
  );
  it("does not read inherited or invalid metadata statuses as success", () => {
    const parts = partsForMessage({
      message: message({
        metadata: {
          type: "reasoning",
          toolCalls: [
            { id: "toString", name: "paste", arguments: "{}" },
            { id: "bad", name: "paste", arguments: "{}" },
          ],
          toolStatuses: { bad: "not-a-status" },
        },
      }),
    });
    expect(parts).toEqual([
      {
        kind: "tool",
        toolCallId: "toString",
        toolName: "paste",
        status: "unknown",
      },
      { kind: "tool", toolCallId: "bad", toolName: "paste", status: "unknown" },
    ]);
  });
});

describe("persisted run outcome parsing", () => {
  it.each(["error", "aborted"] as const)(
    "reads the locale-neutral %s outcome",
    (outcome) => {
      expect(
        persistedRunOutcomeOf(message({ metadata: { runOutcome: outcome } })),
      ).toBe(outcome);
    },
  );
  it("rejects malformed and inherited terminal flags", () => {
    for (const runOutcome of [null, "done", "", [], { error: true }, 7]) {
      expect(
        persistedRunOutcomeOf(message({ metadata: { runOutcome } })),
      ).toBeNull();
    }
    expect(persistedRunOutcomeOf(message())).toBeNull();
    expect(
      persistedRunOutcomeOf(
        message({ metadata: Object.create({ runOutcome: "error" }) }),
      ),
    ).toBeNull();
  });
});
