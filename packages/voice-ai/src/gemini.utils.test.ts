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
      model: "gemini-3.7-flash",
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
        model: "gemini-3.7-flash",
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
        model: "gemini-3.7-flash",
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
        model: "gemini-3.7-flash",
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
        model: "gemini-3.7-flash",
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
        model: "gemini-3.7-flash",
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
    let pump: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Never-ending stream of valid chunks.
        pump = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\r\n\r\n',
              ),
            );
          } catch {
            // Stream already closed/cancelled.
          }
        }, 5);
      },
      cancel() {
        canceled = true;
        clearInterval(pump);
      },
    });
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));

    const generator = geminiStreamChat({
      apiKey: "gemini-key",
      model: "gemini-3.7-flash",
      input: { messages: [{ role: "user", content: "Hi" }] },
      customFetch,
    });
    const first = await generator.next();
    expect(first.done).toBe(false);
    await generator.return(undefined);
    // Give the generator's finally-block cancellation a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
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
      model: "gemini-3.7-flash",
      prompt: "Hi",
      signal: controller.signal,
      customFetch,
    });
    const generateSignal = customFetch.mock.calls[0]?.[1]?.signal;
    expect(generateSignal).toBeTruthy();
    // The forwarded signal must observe the caller's abort (it may be a
    // composite signal combining the caller's signal with the request
    // deadline).
    controller.abort();
    expect(generateSignal?.aborted).toBe(true);

    customFetch.mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "w" }] } }] }),
    );
    await geminiTranscribeAudio({
      apiKey: "gemini-key",
      model: "gemini-3.7-flash",
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
      model: "gemini-3.7-flash",
      prompt: "p",
      customFetch,
    });
    const url = String(customFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/models/gemini-3.7-flash:generateContent");
  });

  it.each(["../x", "a/../b", "a%2Fb", "models/../../admin:foo"])(
    "rejects hostile model id %j before any HTTP call",
    async (model) => {
      // A well-formed Response stands in so pre-guard behavior reaches the
      // network layer; the guard must reject before the fetch is attempted.
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
      model: "gemini-3.7-flash",
      prompt: "Hi",
      customFetch,
    });
    expect(signals).toHaveLength(2);
    // The deadline must cover the whole operation: one signal instance,
    // minted before the first attempt, not a fresh timer per attempt.
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
        model: "gemini-3.7-flash",
        blob: new Uint8Array([1]).buffer,
        signal: controller.signal,
        customFetch,
      }),
    ).rejects.toThrow();
    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
