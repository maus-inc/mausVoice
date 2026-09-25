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
  it("sends full JSON response schemas through the JSON Schema field", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"result":"styled"}' }] } }],
      }),
    );
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    };
    await geminiGenerateTextResponse({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      prompt: "sample",
      jsonResponse: { name: "transcription_cleaning", schema },
      customFetch,
    });
    const body = JSON.parse(customFetch.mock.calls[0]![1].body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema).toEqual(schema);
    expect(body.generationConfig).not.toHaveProperty("responseSchema");
  });

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
        model: "gemini-3.8-flash",
        system: "Be concise.",
        prompt: "Hello",
        customFetch,
      }),
    ).resolves.toEqual({ text: "hello world", tokensUsed: 7 });

    const [url, init] = customFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
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

  it("uses the injected fetch for audio transcription with general model", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "transcript" }] } }],
      }),
    );

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
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

  it("uses Files API and audioTranscriptionConfig for dedicated transcribe model", async () => {
    const customFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/upload/v1beta/files") && init?.method === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({}), {
              status: 200,
              headers: {
                "x-goog-upload-url": "https://upload.example.com/resumable",
              },
            }),
          );
        }
        if (url.includes("upload.example.com")) {
          return Promise.resolve(
            jsonResponse({
              file: {
                uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
                mimeType: "audio/wav",
              },
            }),
          );
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "GET") {
          return Promise.resolve(
            jsonResponse({
              state: "ACTIVE",
            }),
          );
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [
              { content: { parts: [{ text: "transcript via transcribe" }] } },
            ],
          }),
        );
      });

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "audio/wav",
        language: "en-US",
        customVocabulary: ["Kubernetes", "BigQuery"],
        transcriptionMode: "smart",
        customFetch,
      }),
    ).resolves.toEqual({ text: "transcript via transcribe", wordsUsed: 3 });

    const generateCalls = customFetch.mock.calls.filter(([u]) =>
      (u as string).includes(":generateContent"),
    );
    expect(generateCalls).toHaveLength(1);
    const [url, init] = generateCalls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents[0].parts[0]).toEqual({
      fileData: {
        mimeType: "audio/wav",
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
      },
    });
    expect(body.generationConfig.audioTranscriptionConfig).toMatchObject({
      languageCodes: ["en-US"],
      customVocabulary: ["Kubernetes", "BigQuery"],
      mode: "SMART",
    });
    // Verify cleanup
    const deleteCalls = customFetch.mock.calls.filter(
      ([u, i]) =>
        (u as string).includes("/v1beta/files/abc") &&
        (i as RequestInit)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(1);
  });

  it("falls back to inlineData when Files API upload fails for transcribe model", async () => {
    const customFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/upload/v1beta/files")) {
        return Promise.resolve(new Response("upload failed", { status: 500 }));
      }
      return Promise.resolve(
        jsonResponse({
          candidates: [
            { content: { parts: [{ text: "fallback transcript" }] } },
          ],
        }),
      );
    });

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "audio/wav",
        language: "auto",
        customFetch,
      }),
    ).resolves.toEqual({ text: "fallback transcript", wordsUsed: 2 });

    // Should have attempted upload start, then fell back to generateContent
    expect(customFetch.mock.calls.length).toBe(2);
    const lastCall = customFetch.mock.calls[customFetch.mock.calls.length - 1]!;
    const body = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: "AQID",
    });
    expect(body.generationConfig.audioTranscriptionConfig).toBeDefined();
  });

  it("does not fallback to inlineData on abort during upload", async () => {
    const controller = new AbortController();
    const customFetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(new Response("upload failed", { status: 500 }));
    });

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        signal: controller.signal,
        customFetch,
      }),
    ).rejects.toThrow();

    expect(customFetch).toHaveBeenCalledTimes(1);
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
      model: "gemini-3.8-flash",
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
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    const body = JSON.parse(init?.body as string);
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: "OBJECT",
      properties: { id: { type: "INTEGER" } },
    });
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("pairs tool results with the declared function name, not the call id", async () => {
    const capturedBodies: unknown[] = [];
    const customFetch = vi.fn().mockImplementation((_url, init) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return Promise.resolve(
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}\r\n\r\n',
        ]),
      );
    });

    for await (const _event of geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      input: {
        messages: [
          { role: "user", content: "Paste it" },
          {
            role: "assistant",
            toolCalls: [{ id: "gemini-tc-7", name: "paste", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "gemini-tc-7", content: "ok" },
        ],
      },
      customFetch,
    })) {
      // drain
    }

    const body = capturedBodies[0] as {
      contents: Array<{
        role: string;
        parts: Array<Record<string, { name?: string } | { text?: string }>>;
      }>;
    };
    const modelTurn = body.contents[1]!;
    const toolTurn = body.contents[2]!;
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts[0]).toEqual({
      functionCall: { name: "paste", args: {} },
    });
    expect(toolTurn.parts[0]).toEqual({
      functionResponse: { name: "paste", response: { result: "ok" } },
    });
  });

  it("makes exactly one request for a permanent 401 failure", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));

    await expect(
      geminiTranscribeAudio({
        apiKey: "bad-key",
        model: "gemini-3.8-flash",
        blob: new Uint8Array([1]).buffer,
        customFetch,
      }),
    ).rejects.toThrow(/401/);
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one request for a permanent 400 failure", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400 }));

    await expect(
      geminiGenerateTextResponse({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
        prompt: "Hi",
        customFetch,
      }),
    ).rejects.toThrow(/400/);
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 rate-limit response", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValue(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
      );

    await expect(
      geminiGenerateTextResponse({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
        prompt: "Hi",
        customFetch,
      }),
    ).resolves.toMatchObject({ text: "ok" });
    expect(customFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a 200 streaming response with a non-SSE body instead of emitting an empty success", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of geminiStreamChat({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
        input: { messages: [{ role: "user", content: "Hi" }] },
        customFetch,
      })) {
        events.push(event);
      }
    }).rejects.toThrow(/non-SSE|empty|malformed/i);
    expect(
      events.some((event) => (event as { type: string }).type === "finish"),
    ).toBe(false);
  });

  it("rejects a 200 streaming response with an empty body", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));

    await expect(async () => {
      for await (const _event of geminiStreamChat({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
        input: { messages: [{ role: "user", content: "Hi" }] },
        customFetch,
      })) {
        // drain
      }
    }).rejects.toThrow();
  });

  it("cancels the response reader when the consumer stops iterating", async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\r\n\r\n',
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));

    const generator = geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      input: { messages: [{ role: "user", content: "Hi" }] },
      customFetch,
    });
    const first = await generator.next();
    expect(first.done).toBe(false);
    await generator.return(undefined);
    expect(canceled).toBe(true);
  });

  it("forwards the abort signal to the transport on every call shape", async () => {
    const controller = new AbortController();
    const customFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ text: "t" }] } }] }),
      );

    await geminiGenerateTextResponse({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      prompt: "Hi",
      signal: controller.signal,
      customFetch,
    });
    const generateSignal = customFetch.mock.calls[0]?.[1]?.signal;
    expect(generateSignal).toBeTruthy();
    controller.abort();
    expect(generateSignal?.aborted).toBe(true);

    customFetch.mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "w" }] } }] }),
    );
    await geminiTranscribeAudio({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      blob: new Uint8Array([1]).buffer,
      signal: controller.signal,
      customFetch,
    });
    const transcribeSignal = customFetch.mock.calls[1]?.[1]?.signal;
    expect(transcribeSignal).toBeTruthy();
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

describe("Gemini model path sanitization", () => {
  it("encodes ordinary model ids into the models/:action URL", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ text: "x" }] } }] }),
      );
    await geminiGenerateTextResponse({
      apiKey: "k",
      model: "gemini-3.8-flash",
      prompt: "p",
      customFetch,
    });
    const url = String(customFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/models/gemini-3.8-flash:generateContent");
  });

  it.each(["../x", "a/../b", "a%2Fb", "models/../../admin:foo"])(
    "rejects hostile model id %j before any HTTP call",
    async (model) => {
      const customFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "x" }] } }],
        }),
      );
      await expect(
        geminiGenerateTextResponse({
          apiKey: "k",
          model,
          prompt: "p",
          customFetch,
        }),
      ).rejects.toThrow(/invalid model id/i);
      expect(customFetch).not.toHaveBeenCalled();
    },
  );
});

describe("Gemini retry policy edge cases", () => {
  it("shares one absolute deadline signal across retried attempts", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const customFetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        if (signals.length === 1) {
          return Promise.resolve(new Response("nope", { status: 500 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
        );
      });

    await geminiGenerateTextResponse({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      prompt: "Hi",
      customFetch,
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("does not retry a deadline abort (TimeoutError-named rejection)", async () => {
    const customFetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) =>
        Promise.reject(
          (init?.signal as AbortSignal | undefined)?.reason ??
            new DOMException("This operation was aborted", "AbortError"),
        ),
      );
    const controller = new AbortController();
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    await expect(
      geminiTranscribeAudio({
        apiKey: "gemini-key",
        model: "gemini-3.8-flash",
        blob: new Uint8Array([1]).buffer,
        signal: controller.signal,
        customFetch,
      }),
    ).rejects.toThrow();
    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
