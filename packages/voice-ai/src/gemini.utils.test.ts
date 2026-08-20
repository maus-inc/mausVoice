import { describe, expect, it, vi } from "vitest";
import {
  geminiGenerateTextResponse,
  geminiStreamChat,
  geminiTestIntegration,
  geminiTranscribeAudio,
} from "./gemini.utils";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

describe("Gemini native transport", () => {
  it("uses the injected fetch for text generation", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hello world" }] } }],
        usageMetadata: { totalTokenCount: 7 },
      }),
    );

    await expect(
      geminiGenerateTextResponse({
        apiKey: " gemini-key ",
        model: "gemini-3.7-flash",
        system: "Be concise.",
        prompt: "Hello",
        customFetch,
      }),
    ).resolves.toEqual({ text: "hello world", tokensUsed: 7 });

    const [url, init] = customFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": "gemini-key",
      },
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "Be concise.\n\nHello" }],
        },
      ],
    });
  });

  it("uses the injected fetch for audio transcription", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "transcript" }] } }],
      }),
    );

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.7-flash",
        blob: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "audio/wav",
        language: "en",
        customFetch,
      }),
    ).resolves.toEqual({ text: "transcript", wordsUsed: 1 });

    const body = JSON.parse(customFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [
        { inlineData: { mimeType: "audio/wav", data: "AQID" } },
        { text: "Transcribe this audio accurately. The audio is in en." },
      ],
    });
  });

  it("buffers split SSE chunks from the injected fetch", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi',
          ' "}]}}]}\r\n\r\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"there"},{"functionCall":{"name":"lookup","args":{"id":3}}}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\r\n\r\n',
        ]),
      );

    const events = [];
    for await (const event of geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.7-flash",
      input: {
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            name: "lookup",
            parameters: {
              type: "object",
              properties: { id: { type: "integer" } },
            },
          },
        ],
      },
      customFetch,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "Hi " },
      { type: "text-delta", text: "there" },
      {
        type: "tool-call",
        id: "gemini-tc-0",
        name: "lookup",
        arguments: '{"id":3}',
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 4, completionTokens: 2 },
      },
    ]);

    const [url, init] = customFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse",
    );
    const body = JSON.parse(init?.body as string);
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: "OBJECT",
      properties: { id: { type: "INTEGER" } },
    });
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("keeps API keys out of model-list URLs", async () => {
    const customFetch = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));

    await expect(
      geminiTestIntegration({ apiKey: " gemini-key ", customFetch }),
    ).resolves.toBe(true);

    expect(customFetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      { headers: { "x-goog-api-key": "gemini-key" } },
    );
  });
});
