import { describe, expect, it, vi } from "vitest";
import type { LlmMessage, LlmStreamEvent } from "@maus-inc/types";
import { claudeStreamChat } from "./claude.utils";
import { geminiStreamChat } from "./gemini.utils";
import type { CustomFetch } from "./types";

const messages: LlmMessage[] = [
  { role: "system", content: "old instructions" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "" },
  {
    role: "assistant",
    content: "Checking",
    toolCalls: [
      { id: "call-1", name: "lookup", arguments: '{"count":1}' },
      { id: "call-2", name: "lookup", arguments: "null" },
      { id: "call-3", name: "lookup", arguments: "malformed" },
    ],
  },
  { role: "tool", toolCallId: "call-1", content: "found" },
  { role: "tool", toolCallId: "call-2", content: "invalid arguments" },
  { role: "tool", toolCallId: "call-3", content: "invalid arguments" },
  { role: "system", content: "current instructions" },
];

const drain = async (stream: AsyncGenerator<LlmStreamEvent>) => {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const streamingFetch = (
  events: Array<{ type?: string; [key: string]: unknown }>,
) =>
  vi.fn<CustomFetch>(
    async () =>
      new Response(
        events
          .map(
            (event) =>
              `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );

const requestBody = (fetch: ReturnType<typeof streamingFetch>) =>
  JSON.parse(String(fetch.mock.calls[0][1]?.body));

describe("streaming provider history", () => {
  it("maps Claude assistant content and object-only tool inputs", async () => {
    const customFetch = streamingFetch([
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    await drain(
      claudeStreamChat({
        apiKey: "test",
        model: "test",
        input: { messages },
        customFetch,
      }),
    );
    expect(requestBody(customFetch)).toMatchObject({
      system: "current instructions",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "tool_use",
              id: "call-1",
              name: "lookup",
              input: { count: 1 },
            },
            { type: "tool_use", id: "call-2", name: "lookup", input: {} },
            { type: "tool_use", id: "call-3", name: "lookup", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "found" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-2",
              content: "invalid arguments",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-3",
              content: "invalid arguments",
            },
          ],
        },
      ],
    });
  });

  it("maps Gemini call IDs to names and skips orphan results", async () => {
    const customFetch = streamingFetch([
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "Done" }] } },
        ],
      },
    ]);
    await drain(
      geminiStreamChat({
        apiKey: "test",
        model: "test",
        input: {
          messages: [
            ...messages,
            { role: "tool", toolCallId: "orphan", content: "unmatched" },
          ],
        },
        customFetch,
      }),
    );
    expect(requestBody(customFetch)).toMatchObject({
      systemInstruction: { parts: [{ text: "current instructions" }] },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        {
          role: "model",
          parts: [
            { text: "Checking" },
            { functionCall: { name: "lookup", args: { count: 1 } } },
            { functionCall: { name: "lookup", args: {} } },
            { functionCall: { name: "lookup", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { result: "found" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { result: "invalid arguments" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { result: "invalid arguments" },
              },
            },
          ],
        },
      ],
    });
  });
});
