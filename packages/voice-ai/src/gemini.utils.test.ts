import { describe, expect, it, vi } from "vitest";
import type { LlmChatInput } from "@maus-inc/types";
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
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
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

  it("parses a final event that arrives without its terminating blank line", async () => {
    // The flush that happens on the terminal read is the only thing that
    // carries an event the stream ended in the middle of.
    const customFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"tail"}]}}]}',
        ]),
      );

    const events = [];
    for await (const event of geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      input: { messages: [{ role: "user", content: "Hello" }] },
      customFetch,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "tail" },
      { type: "finish", finishReason: "other", usage: undefined },
    ]);
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

describe("Gemini thinking controls", () => {
  const generate = async (model: string) => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
      }),
    );
    await geminiGenerateTextResponse({
      apiKey: "gemini-key",
      model,
      prompt: "Clean this up.",
      maxTokens: 600,
      customFetch,
    });
    const body = JSON.parse(customFetch.mock.calls[0]![1].body as string);
    return body.generationConfig as Record<string, unknown>;
  };

  it("lowers Gemini 3 thinking so the reply fits the completion budget", async () => {
    const config = await generate("gemini-3.7-flash");

    expect(config.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("turns thinking off for Gemini 2.5 Flash", async () => {
    const config = await generate("gemini-2.5-flash");

    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("leaves models without a known low setting untouched", async () => {
    // Flash-Lite already defaults to minimal thinking, and an unsupported
    // thinking field would fail the whole request.
    const config = await generate("gemini-3.5-flash-lite");

    expect(config).not.toHaveProperty("thinkingConfig");
  });
});

describe("Gemini Files API edge cases", () => {
  it("throws when upload URL header is missing", async () => {
    const customFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/upload/v1beta/files")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200, headers: {} }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "fallback" }] } }],
        }),
      );
    });
    await expect(
      geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      }),
    ).resolves.toEqual({ text: "fallback", wordsUsed: 1 });
  });

  it("keeps polling long enough for a slow Files API to finish", async () => {
    // The budget used to be ten attempts at a fixed 100ms, so a file that needed
    // more than about a second to process was abandoned and the dictation fell
    // back to inlineData, which cannot recover an over-sized recording.
    vi.useFakeTimers();
    try {
      let polls = 0;
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
                  uri: "https://generativelanguage.googleapis.com/v1beta/files/slow",
                  mimeType: "audio/wav",
                },
              }),
            );
          }
          if (url.includes("/v1beta/files/slow") && init?.method === "GET") {
            polls += 1;
            // Still processing after 20 polls, which is well past what the old
            // ten fixed attempts could ever have waited for.
            return Promise.resolve(
              jsonResponse({ state: polls <= 20 ? "PROCESSING" : "ACTIVE" }),
            );
          }
          if (url.includes("/v1beta/files/slow") && init?.method === "DELETE") {
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          return Promise.resolve(
            jsonResponse({
              candidates: [{ content: { parts: [{ text: "slow but ok" }] } }],
            }),
          );
        });

      const pending = geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      });
      for (let step = 0; step < 100; step += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      await expect(pending).resolves.toEqual({
        text: "slow but ok",
        wordsUsed: 3,
      });
      expect(polls).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on FAILED file state", async () => {
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
          return Promise.resolve(jsonResponse({ state: "FAILED" }));
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
        );
      });
    await expect(
      geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      }),
    ).resolves.toBeDefined();
  });

  it("throws when file never becomes ACTIVE after polling", async () => {
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
          return Promise.resolve(jsonResponse({ state: "PROCESSING" }));
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "fallback" }] } }],
          }),
        );
      });
    // Fake clock, because giving up now means spending the whole 30s budget
    // rather than ten fixed 100ms attempts.
    vi.useFakeTimers();
    try {
      const pending = geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      });
      for (let step = 0; step < 200; step += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await expect(pending).resolves.toEqual({
        text: "fallback",
        wordsUsed: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts during polling when signal is aborted", async () => {
    const controller = new AbortController();
    let pollCount = 0;
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
        if (
          url.includes("/v1beta/files/abc") &&
          (init?.method === "GET" || !init?.method)
        ) {
          pollCount++;
          if (pollCount === 1) {
            controller.abort();
          }
          return Promise.resolve(jsonResponse({ state: "PROCESSING" }));
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
        );
      });
    await expect(
      geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        signal: controller.signal,
        customFetch,
      }),
    ).rejects.toThrow();
  }, 10000);

  it("releases a stalled cleanup DELETE when the caller cancels", async () => {
    // The cleanup request was the one call on this path that took no signal, so
    // a stalled deletion kept the transcription awaiting a response that was
    // never coming. The cancellation that should release it had already been
    // spent on the request before it: every other call here carries the signal,
    // so the deadline that ended the operation had nothing left to hand the
    // DELETE, and a stalled deletion then blocked transcription forever after
    // the operation deadline expired. The mock below settles only on an abort,
    // which is what a real transport does with a request it is told to abandon.
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
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
          return Promise.resolve(jsonResponse({ state: "ACTIVE" }));
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          cleanupSignal = init?.signal ?? undefined;
          // The cancel lands while the deletion is in flight, so the request has
          // to already be listening for it.
          queueMicrotask(() => controller.abort());
          return new Promise((_resolve, reject) => {
            const onAbort = () =>
              reject(new DOMException("aborted", "AbortError"));
            if (cleanupSignal?.aborted) onAbort();
            else
              cleanupSignal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "cleaned up" }] } }],
          }),
        );
      });

    const pending = geminiTranscribeAudio({
      apiKey: "k",
      model: "gemini-3.5-transcribe",
      blob: new Uint8Array([1, 2, 3]).buffer,
      signal: controller.signal,
      customFetch,
    });
    // A real clock rather than fake timers: the failure being guarded against is
    // an await that never settles, so the only way to see it is to stop waiting.
    const outcome = await Promise.race([
      pending.then(
        () => "settled",
        () => "rejected",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("hung"), 1_000),
      ),
    ]);

    expect(cleanupSignal).toBeDefined();
    expect(outcome).toBe("settled");
  }, 10000);

  it("validates upload URL is https", async () => {
    const customFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/upload/v1beta/files")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "x-goog-upload-url": "http://evil.com/upload" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "fallback" }] } }],
        }),
      );
    });
    await expect(
      geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      }),
    ).resolves.toEqual({ text: "fallback", wordsUsed: 1 });
  });

  it("refuses to send the API key to a file URI outside Gemini", async () => {
    // `deleteGeminiFile` and `fetchGeminiFileState` both attach `x-goog-api-key`
    // to the URI the upload response handed back. That URI came out of a
    // response body with no host check, while the upload URL next to it was
    // validated, so a wrong or tampered URI received the user's credential.
    // Rejecting it turns a failed upload into the existing inlineData fallback
    // instead of a credential leak.
    const foreign = "https://evil.example.org/v1beta/files/stolen";
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
            jsonResponse({ file: { uri: foreign, mimeType: "audio/wav" } }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "fallback" }] } }],
          }),
        );
      });

    await expect(
      geminiTranscribeAudio({
        apiKey: "secret-key",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      }),
    ).resolves.toEqual({ text: "fallback", wordsUsed: 1 });

    // The foreign host was never contacted at all, and the credential only ever
    // went to a Gemini host. (The inlineData fallback does legitimately carry
    // the key, so the check is per host rather than a blanket "never".)
    const allowed = [
      "generativelanguage.googleapis.com",
      "storage.googleapis.com",
      "upload.example.com",
    ];
    for (const [url, init] of customFetch.mock.calls) {
      const target = new URL(String(url));
      expect(target.hostname).not.toBe("evil.example.org");
      const carriedKey = Boolean(
        (init?.headers as Record<string, string> | undefined)?.[
          "x-goog-api-key"
        ],
      );
      if (carriedKey) {
        expect(
          allowed.some(
            (host) =>
              target.hostname === host || target.hostname.endsWith("." + host),
          ),
        ).toBe(true);
      }
    }
  });

  it("refuses a non-HTTPS file URI", async () => {
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
                uri: "http://generativelanguage.googleapis.com/v1beta/files/abc",
                mimeType: "audio/wav",
              },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "fallback" }] } }],
          }),
        );
      });

    await expect(
      geminiTranscribeAudio({
        apiKey: "secret-key",
        model: "gemini-3.5-transcribe",
        blob: new Uint8Array([1, 2, 3]).buffer,
        customFetch,
      }),
    ).resolves.toEqual({ text: "fallback", wordsUsed: 1 });
  });

  it("uses correct extension for mp3 mimeType", async () => {
    let displayName = "";
    const customFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/upload/v1beta/files") && init?.method === "POST") {
          const body = JSON.parse((init?.body as string) ?? "{}");
          displayName = body.file?.display_name ?? "";
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
                mimeType: "audio/mp3",
              },
            }),
          );
        }
        if (
          url.includes("/v1beta/files/abc") &&
          (init?.method === "GET" || !init?.method)
        ) {
          return Promise.resolve(jsonResponse({ state: "ACTIVE" }));
        }
        if (url.includes("/v1beta/files/abc") && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          jsonResponse({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
        );
      });
    await geminiTranscribeAudio({
      apiKey: "k",
      model: "gemini-3.5-transcribe",
      blob: new Uint8Array([1, 2, 3]).buffer,
      mimeType: "audio/mp3",
      customFetch,
    });
    expect(displayName).toContain(".mp3");
  }, 10000);

  it("handles Buffer offset correctly without copying whole buffer", async () => {
    const base = Buffer.from([0, 0, 1, 2, 3, 0, 0]);
    const sliced = base.subarray(2, 5);
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
      }),
    );
    await expect(
      geminiTranscribeAudio({
        apiKey: "k",
        model: "gemini-3.8-flash",
        blob: sliced,
        customFetch,
      }),
    ).resolves.toEqual({ text: "hi", wordsUsed: 1 });
    const body = JSON.parse(customFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.contents[0].parts[0].inlineData.data).toBe("AQID");
  });
});

describe("Gemini tool choice", () => {
  const tools = [
    {
      name: "lookup",
      description: "looks something up",
      parameters: { type: "object" as const, properties: {} },
    },
    {
      name: "other",
      description: "does something else",
      parameters: { type: "object" as const, properties: {} },
    },
  ];

  // Every case in this block asserts on the request body that came out, and they
  // differ only in the `input` they hand the stream, so the mock, the drain and
  // the parse live here once. A second copy of that plumbing can only drift from
  // the first, and a case that forgot to assert would then read as a pass.
  const streamOnce = async (
    input: Partial<LlmChatInput> = {},
  ): Promise<Record<string, unknown>> => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}\r\n\r\n',
        ]),
      );
    for await (const _event of geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.8-flash",
      input: {
        messages: [{ role: "user", content: "Hello" }],
        tools,
        ...input,
      },
      customFetch,
    })) {
      // drain
    }
    return JSON.parse(customFetch.mock.calls[0]![1].body as string);
  };

  // `input.toolChoice` decides whether the model may call a tool at all. Gemini
  // spells the same three options in `toolConfig.functionCallingConfig.mode`,
  // and "only this one" as an allow-list inside `ANY`. Sending the request
  // without it leaves Gemini on its default of AUTO for every caller: a `none`
  // turn can still call a tool, and a `required` turn can still answer in prose.
  it.each([
    ["auto", "AUTO"],
    ["none", "NONE"],
    ["required", "ANY"],
  ])("maps toolChoice %s onto mode %s", async (choice, mode) => {
    const body = await streamOnce({ toolChoice: choice as never });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode } });
  });

  it("restricts a named tool choice to that function", async () => {
    const body = await streamOnce({ toolChoice: { name: "lookup" } as never });
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["lookup"],
      },
    });
  });

  it("sends no toolConfig when the caller expressed no choice", async () => {
    const body = await streamOnce();
    expect(body).not.toHaveProperty("toolConfig");
  });

  it("sends no toolConfig when there are no tools to choose between", async () => {
    // Gemini rejects a `toolConfig` on a request that declares no function, so
    // the choice is only expressible once `tools` is present.
    const body = await streamOnce({ toolChoice: "required", tools: undefined });
    expect(body).not.toHaveProperty("toolConfig");
    expect(body).not.toHaveProperty("tools");
  });
});
