import type { ChatMessage, ToolPermission } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import { describe, expect, it } from "vitest";
import type { AppState } from "../../state/app.state";
import {
  buildNativePillPayload,
  selectNativePillState,
  type NativePillSyncState,
} from "./native-pill-payload";

const intl = {
  formatMessage: ({ defaultMessage }: { defaultMessage?: string }) =>
    defaultMessage ?? "",
} as unknown as IntlShape;

const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
  metadata: ChatMessage["metadata"] = null,
): ChatMessage => ({
  id,
  conversationId: "conversation-1",
  role,
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
  metadata,
});

const emptyState = (
  overrides: Partial<NativePillSyncState> = {},
): NativePillSyncState => ({
  activeRecordingMode: null,
  pendingPillReview: null,
  assistantInputMode: "voice",
  pillConversationId: "conversation-1",
  chatMessageById: {},
  chatMessageIdsByConversationId: {},
  toolPermissionById: {},
  toolInfoById: {},
  streamingMessageById: {},
  ...overrides,
});

const stateWith = (
  messages: ChatMessage[],
  overrides: Partial<NativePillSyncState> = {},
): NativePillSyncState =>
  emptyState({
    chatMessageById: Object.fromEntries(messages.map((m) => [m.id, m])),
    chatMessageIdsByConversationId: {
      "conversation-1": messages.map((m) => m.id),
    },
    ...overrides,
  });

const permission = (overrides: Partial<ToolPermission> = {}): ToolPermission =>
  ({
    id: "permission-1",
    toolId: "write_file",
    params: {},
    status: "pending",
    ...({
      conversationId: "conversation-1",
    } as Record<string, unknown>),
    ...overrides,
  }) as ToolPermission;

describe("selectNativePillState", () => {
  it("projects only the fields the pill reads", () => {
    const state = {
      ...emptyState(),
      initialized: true,
      auth: null,
    } as unknown as AppState;

    const projected = selectNativePillState(state);

    expect(Object.keys(projected).sort()).toEqual(
      [
        "activeRecordingMode",
        "assistantInputMode",
        "chatMessageById",
        "chatMessageIdsByConversationId",
        "pendingPillReview",
        "pillConversationId",
        "streamingMessageById",
        "toolInfoById",
        "toolPermissionById",
      ].sort(),
    );
  });
});

describe("buildNativePillPayload", () => {
  it("drops user turns but keeps system errors and non-empty assistant turns", () => {
    const payload = buildNativePillPayload(
      stateWith([
        message("u1", "user", "how do I sort this?"),
        message("a1", "assistant", "Use the sort button."),
        message("s1", "system", "Tool failed"),
        message("a2", "assistant", "   "),
      ]),
      intl,
    );

    expect(payload.messages.map((m) => m.id)).toEqual(["a1", "s1"]);
    expect(payload.messages[1].is_error).toBe(true);
    expect(payload.messages[0].is_error).toBe(false);
  });

  it("keeps an empty assistant turn only while it is streaming", () => {
    const streaming = {
      toolCalls: [],
      reasoning: "",
      isStreaming: true,
    };
    const withoutStream = buildNativePillPayload(
      stateWith([message("a1", "assistant", "")]),
      intl,
    );
    const withStream = buildNativePillPayload(
      stateWith([message("a1", "assistant", "")], {
        streamingMessageById: { a1: streaming },
      }),
      intl,
    );

    expect(withoutStream.messages).toEqual([]);
    expect(withStream.messages.map((m) => m.id)).toEqual(["a1"]);
  });

  it("strips markdown from assistant text only", () => {
    const payload = buildNativePillPayload(
      stateWith([
        message("a1", "assistant", "## Result\n\n**Bold** and `code`"),
        message("s1", "system", "**raw** system text"),
      ]),
      intl,
    );

    expect(payload.messages[0].content).toContain("Bold");
    expect(payload.messages[0].content).not.toContain("**");
    expect(payload.messages[0].content).not.toContain("##");
    expect(payload.messages[1].content).toBe("**raw** system text");
  });

  it("resolves tool metadata from the tool catalog", () => {
    const payload = buildNativePillPayload(
      stateWith(
        [
          message("a1", "assistant", "done", {
            type: "tool-result",
            toolName: "write_file",
            reason: "user asked",
          }),
          message("a2", "assistant", "unknown tool", { toolName: "missing" }),
        ],
        {
          toolInfoById: {
            write_file: {
              id: "write_file",
              description: "Writes a file",
              instructions: "",
              schema: {},
            },
          },
        },
      ),
      intl,
    );

    expect(payload.messages[0]).toMatchObject({
      is_tool_result: true,
      tool_name: "write_file",
      tool_description: "Writes a file",
      reason: "user asked",
    });
    expect(payload.messages[1]).toMatchObject({
      is_tool_result: false,
      tool_name: "missing",
      tool_description: null,
      reason: null,
    });
  });

  it("selects the newest streaming message and maps its tool calls", () => {
    const payload = buildNativePillPayload(
      stateWith(
        [
          message("a1", "assistant", "first"),
          message("a2", "assistant", "second"),
        ],
        {
          streamingMessageById: {
            a1: {
              toolCalls: [],
              reasoning: "old",
              isStreaming: false,
            },
            a2: {
              toolCalls: [
                { toolCallId: "call-1", toolName: "search", done: true },
              ],
              reasoning: "thinking",
              isStreaming: true,
            },
          },
        },
      ),
      intl,
    );

    expect(payload.streaming).toEqual({
      message_id: "a2",
      tool_calls: [{ id: "call-1", name: "search", done: true }],
      reasoning: "thinking",
      is_streaming: true,
    });
  });

  it("reports no streaming when nothing in the conversation is streaming", () => {
    const payload = buildNativePillPayload(
      stateWith([message("a1", "assistant", "done")], {
        streamingMessageById: {
          other: { toolCalls: [], reasoning: "", isStreaming: true },
        },
      }),
      intl,
    );

    expect(payload.streaming).toBeNull();
  });

  it("offers only pending permissions that belong to the pill conversation", () => {
    const payload = buildNativePillPayload(
      stateWith([], {
        pillConversationId: "conversation-1",
        toolPermissionById: {
          mine: permission(),
          other: permission({
            id: "permission-2",
            conversationId: "conversation-2",
          } as unknown as Partial<ToolPermission>),
          settled: permission({ id: "permission-3", status: "allowed" }),
        },
        toolInfoById: {
          write_file: {
            id: "write_file",
            description: "Writes a file",
            instructions: "",
            schema: {},
          },
        },
      }),
      intl,
    );

    expect(payload.permissions).toEqual([
      {
        id: "permission-1",
        tool_name: "write_file",
        description: "Writes a file",
        reason: null,
      },
    ]);
  });

  it("reports no permissions without a pill conversation", () => {
    const payload = buildNativePillPayload(
      stateWith([], {
        pillConversationId: null,
        toolPermissionById: { mine: permission() },
      }),
      intl,
    );

    expect(payload.permissions).toEqual([]);
    expect(payload.conversation_id).toBeNull();
  });

  it("previews a long user prompt from its head and tail", () => {
    const long = buildNativePillPayload(
      stateWith([
        message(
          "u1",
          "user",
          "one two three four five six seven eight nine ten eleven twelve",
        ),
      ]),
      intl,
    );
    const short = buildNativePillPayload(
      stateWith([message("u2", "user", "   short   prompt  ")]),
      intl,
    );

    expect(long.user_prompt).toBe(
      "one two three four ... eight nine ten eleven twelve",
    );
    expect(short.user_prompt).toBe("short prompt");
  });

  it("reports no prompt when the conversation has no user turn", () => {
    const payload = buildNativePillPayload(
      stateWith([message("a1", "assistant", "hi")]),
      intl,
    );

    expect(payload.user_prompt).toBeNull();
  });

  it("stays compact only for an empty voice conversation without a review", () => {
    expect(buildNativePillPayload(stateWith([]), intl).compact).toBe(true);
    expect(buildNativePillPayload(stateWith([]), intl).active).toBe(false);
    expect(
      buildNativePillPayload(
        stateWith([], { assistantInputMode: "type" }),
        intl,
      ).compact,
    ).toBe(false);
    expect(
      buildNativePillPayload(
        stateWith([message("a1", "assistant", "hi")]),
        intl,
      ).compact,
    ).toBe(false);
    expect(
      buildNativePillPayload(
        stateWith([], { pendingPillReview: { id: "review-1", text: "text" } }),
        intl,
      ).compact,
    ).toBe(false);
  });

  it("marks the agent recording mode active and defaults the input mode", () => {
    const payload = buildNativePillPayload(
      emptyState({
        activeRecordingMode: "agent",
        assistantInputMode: undefined,
      }),
      intl,
    );

    expect(payload.active).toBe(true);
    expect(payload.input_mode).toBe("voice");
    expect(payload.type).toBe("assistant_state");
  });

  it("ships every review caption across the bridge", () => {
    const payload = buildNativePillPayload(
      stateWith([], {
        pendingPillReview: { id: "review-1", text: "hello there" },
      }),
      intl,
    );

    expect(payload.review).toEqual({
      id: "review-1",
      text: "hello there",
      edit_label: "Edit",
      insert_label: "Insert",
      copy_label: "Copy",
      cancel_label: "Cancel",
      hint: "Edit below, then press Enter to insert",
    });
  });
});
