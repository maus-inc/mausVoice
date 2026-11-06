import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { openaiCompatibleStreamChat } from "./openai.utils";

describe("OpenAI-compatible streamed tool calls", () => {
  it("accumulates interleaved arguments, ignores empty fragments and sorts calls by index", async () => {
    const chunks = [
      {
        model: "model-1",
        choices: [
          {
            delta: {
              content: "hello",
              tool_calls: [
                {
                  index: 1,
                  id: "call-b",
                  function: { name: "second", arguments: '{"b":' },
                },
                {
                  index: 0,
                  id: "call-a",
                  function: { name: "first", arguments: '{"a":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "", function: { name: "", arguments: "1}" } },
                { index: 1, function: { arguments: "2}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield* chunks;
      })(),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const events = [];
    for await (const event of openaiCompatibleStreamChat(
      client,
      "requested-model",
      { messages: [{ role: "user", content: "Hi" }] },
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "tool-call", id: "call-a", name: "first", arguments: '{"a":1}' },
      { type: "tool-call", id: "call-b", name: "second", arguments: '{"b":2}' },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { promptTokens: 10, completionTokens: 5 },
        modelId: "model-1",
      },
    ]);
  });

  it("assigns missing indices to the next map slot and defaults missing fields", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: { tool_calls: [{ function: {} }, { id: "next" }] },
            finish_reason: "stop",
          },
        ],
      },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield* chunks;
      })(),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const events = [];
    for await (const event of openaiCompatibleStreamChat(client, "model", {
      messages: [],
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "tool-call", id: "", name: "", arguments: "" },
      { type: "tool-call", id: "next", name: "", arguments: "" },
      {
        type: "finish",
        finishReason: "stop",
        usage: undefined,
        modelId: undefined,
      },
    ]);
  });
});
