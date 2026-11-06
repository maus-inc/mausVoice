import { HttpError } from "@maus-inc/utilities";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aldeaTestIntegration, aldeaTranscribeAudio } from "./aldea.utils";
import { deepgramTranscribeAudio } from "./deepgram.utils";
import {
  geminiGenerateTextResponse,
  geminiTestIntegration,
} from "./gemini.utils";
import { requestSpeaches } from "./speaches.utils";
import { parsePrivateProviderJson } from "./provider-response.utils";
import {
  elevenlabsTestIntegration,
  elevenlabsTranscribeAudio,
} from "./elevenlabs.utils";
import {
  xaiGenerateSpeech,
  xaiTestIntegration,
  xaiTranscribeAudio,
} from "./xai.utils";

const audio = new ArrayBuffer(2);
const errorResponse = () =>
  Promise.resolve(
    new Response("bad key", {
      status: 401,
      headers: { "retry-after": "1" },
    }),
  );

const sensitiveErrorResponse = () =>
  Promise.resolve(
    new Response("partial private transcript example-opaque-secret", {
      status: 401,
      headers: { "retry-after": "1" },
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe("provider response cancellation", () => {
  it("closes a real stalled HTTP response when its JSON read is aborted", async () => {
    let connectionClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      connectionClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.on("close", connectionClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"text":"');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      // Deliberately leave the fetch without a signal, so the JSON reader must
      // cancel the response rather than relying on transport cancellation.
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const controller = new AbortController();
      const pending = parsePrivateProviderJson(
        response,
        "provider",
        controller.signal,
      );
      controller.abort(null);
      await expect(pending).rejects.toBe(null);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            closed.then(() => "closed"),
            new Promise<string>((resolve) => {
              timeout = setTimeout(() => resolve("stalled"), 2000);
            }),
          ]),
        ).resolves.toBe("closed");
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Aldea transport privacy", () => {
  it("does not expose transport error fragments from transcription or integration", async () => {
    const fragment = "private-fragment-of-key-or-audio";
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(fragment));
    vi.stubGlobal("fetch", transport);
    for (const call of [
      () => aldeaTranscribeAudio({ apiKey: "secret", blob: audio }),
      () => aldeaTestIntegration({ apiKey: "secret" }),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(fragment);
    }
  });

  it("preserves caller cancellation and disposes a late response", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const cancel = vi.fn();
    let finish!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", transport);
    const request = aldeaTranscribeAudio({
      apiKey: "secret",
      blob: audio,
      signal: controller.signal,
    });
    controller.abort(reason);
    const response = new Response(new ReadableStream({ cancel }));
    finish(response);
    await expect(request).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();

    const before = new AbortController();
    before.abort(reason);
    await expect(
      aldeaTranscribeAudio({
        apiKey: "secret",
        blob: audio,
        signal: before.signal,
      }),
    ).rejects.toBe(reason);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([new Error("cancelled during retry wait"), null])(
    "aborts the Aldea retry wait with the caller's reason %#",
    async (reason) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const transport = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            status: 429,
            headers: { "retry-after": "2" },
          }),
        );
        vi.stubGlobal("fetch", transport);
        let caught: unknown;
        void aldeaTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          signal: controller.signal,
        }).catch((error: unknown) => {
          caught = error;
        });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(reason);
        await vi.advanceTimersByTimeAsync(1);
        expect(caught).toBe(reason);
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("sanitizes independent transport abort errors", async () => {
    const error = new DOMException("private fragment", "AbortError");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(error));
    await expect(
      aldeaTranscribeAudio({ apiKey: "secret", blob: audio }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Aldea request cancelled",
    });
  });

  it("rejects redirects for private audio and credential probes", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: {
              channels: [{ alternatives: [{ transcript: "hello" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", transport);
    await expect(
      aldeaTranscribeAudio({ apiKey: "secret", blob: audio }),
    ).resolves.toMatchObject({ text: "hello" });
    await expect(aldeaTestIntegration({ apiKey: "secret" })).resolves.toBe(
      true,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, init] of transport.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });
});

describe("provider redirect privacy", () => {
  it.each([
    [
      "Deepgram audio",
      (customFetch: typeof fetch) =>
        deepgramTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs audio",
      (customFetch: typeof fetch) =>
        elevenlabsTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs credentials",
      (customFetch: typeof fetch) =>
        elevenlabsTestIntegration({ apiKey: "secret", customFetch }),
    ],
    [
      "xAI audio",
      (customFetch: typeof fetch) =>
        xaiTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "xAI text",
      (customFetch: typeof fetch) =>
        xaiGenerateSpeech({ apiKey: "secret", text: "private", customFetch }),
    ],
    [
      "xAI credentials",
      (customFetch: typeof fetch) =>
        xaiTestIntegration({ apiKey: "secret", customFetch }),
    ],
  ])("does not follow redirects for %s", async (_, call) => {
    const transport = vi.fn<typeof fetch>(errorResponse);
    await expect(call(transport)).rejects.toBeDefined();
    expect(transport).toHaveBeenCalled();
    for (const [, init] of transport.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });
});

describe("real redirect behavior", () => {
  it.each([307, 308])(
    "never forwards private text or provider keys on HTTP %i",
    async (status) => {
      let forwarded = 0;
      let received = "";
      const destination = createServer((request, response) => {
        forwarded++;
        request.resume();
        response.end("unexpected");
      });
      await new Promise<void>((resolve) =>
        destination.listen(0, "127.0.0.1", resolve),
      );
      const targetPort = (destination.address() as AddressInfo).port;
      const source = createServer((request, response) => {
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          received += chunk;
        });
        request.on("end", () => {
          response.writeHead(status, {
            location: `http://127.0.0.1:${targetPort}/stolen`,
          });
          response.end();
        });
      });
      await new Promise<void>((resolve) =>
        source.listen(0, "127.0.0.1", resolve),
      );
      const sourcePort = (source.address() as AddressInfo).port;
      const transport: typeof fetch = (_, init) =>
        fetch(`http://127.0.0.1:${sourcePort}/`, init);
      try {
        await expect(
          xaiGenerateSpeech({
            apiKey: "secret",
            text: "private words",
            customFetch: transport,
          }),
        ).rejects.toBeDefined();
        await expect(
          elevenlabsTestIntegration({
            apiKey: "secret",
            customFetch: transport,
          }),
        ).rejects.toBeDefined();
        await expect(
          requestSpeaches(
            "https://example.invalid/v1/audio/transcriptions",
            { method: "POST", body: "speaches private audio" },
            transport,
          ),
        ).rejects.toBeDefined();
        await expect(
          geminiGenerateTextResponse({
            apiKey: "secret",
            prompt: "gemini private words",
            customFetch: transport,
          }),
        ).rejects.toBeDefined();
        await expect(
          geminiTestIntegration({ apiKey: "secret", customFetch: transport }),
        ).rejects.toBeDefined();
        expect(received).toContain("gemini private words");
        expect(received).toContain("speaches private audio");
        expect(received).toContain("private words");
        expect(forwarded).toBe(0);
      } finally {
        source.closeAllConnections();
        destination.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve, reject) =>
            source.close((error) => (error ? reject(error) : resolve())),
          ),
          new Promise<void>((resolve, reject) =>
            destination.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
      }
    },
  );
});

describe("private provider transport diagnostics", () => {
  it.each([
    [
      "Deepgram transcription",
      (customFetch: typeof fetch) =>
        deepgramTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs transcription",
      (customFetch: typeof fetch) =>
        elevenlabsTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs integration",
      (customFetch: typeof fetch) =>
        elevenlabsTestIntegration({ apiKey: "secret", customFetch }),
    ],
    [
      "xAI transcription",
      (customFetch: typeof fetch) =>
        xaiTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "xAI speech",
      (customFetch: typeof fetch) =>
        xaiGenerateSpeech({ apiKey: "secret", text: "private", customFetch }),
    ],
    [
      "xAI integration",
      (customFetch: typeof fetch) =>
        xaiTestIntegration({ apiKey: "secret", customFetch }),
    ],
  ] as const)(
    "%s omits private transport failure details",
    async (_provider, request) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("private transport fragment"));
      const error = await request(transport).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private transport fragment");
    },
  );
});

describe("private transcription cancellation", () => {
  const providers = [
    [
      "Deepgram",
      (customFetch: typeof fetch, signal: AbortSignal) =>
        deepgramTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
          signal,
        }),
    ],
    [
      "ElevenLabs",
      (customFetch: typeof fetch, signal: AbortSignal) =>
        elevenlabsTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
          signal,
        }),
    ],
    [
      "xAI",
      (customFetch: typeof fetch, signal: AbortSignal) =>
        xaiTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch,
          signal,
        }),
    ],
  ] as const;

  it.each(providers)(
    "%s keeps terminal HTTP status and hides transport details",
    async (_provider, request) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new HttpError(401, "private transport fragment", { retryAfter: "1" }),
        );
      const result = await request(
        transport,
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(HttpError);
      expect(result).toMatchObject({ status: 401, retryAfterMs: 1000 });
      expect(String(result)).not.toContain("private transport fragment");
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each(providers)(
    "%s does not retry a terminal transport error with an unreadable name",
    async (_provider, request) => {
      const failure = Object.assign(new Error("private transport fragment"), {
        status: 401,
      });
      Object.defineProperty(failure, "name", {
        get() {
          throw new Error("private accessor fragment");
        },
      });
      const transport = vi.fn<typeof fetch>().mockRejectedValue(failure);
      const result = await request(
        transport,
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      expect(result).toMatchObject({ status: 401 });
      expect(String(result)).not.toContain("private");
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([null, "1"])(
    "preserves the Deepgram transport retry delay for hint %s",
    async (hint) => {
      vi.useFakeTimers();
      try {
        const delay = hint === null ? 20 : 1000;
        const transport = vi
          .fn<typeof fetch>()
          .mockRejectedValueOnce(
            new HttpError(503, "private", { retryAfter: hint }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                results: {
                  channels: [{ alternatives: [{ transcript: "ok" }] }],
                },
              }),
              { status: 200 },
            ),
          );
        const pending = deepgramTranscribeAudio({
          apiKey: "secret",
          blob: audio,
          ext: "wav",
          customFetch: transport,
        });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(transport).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({ text: "ok" });
        expect(transport).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(providers)(
    "%s does not dispatch a pre-aborted request",
    async (_provider, request) => {
      const controller = new AbortController();
      controller.abort(null);
      const transport = vi.fn<typeof fetch>();
      await expect(request(transport, controller.signal)).rejects.toBe(null);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(providers)(
    "%s stops waiting for a transport that ignores cancellation",
    async (_provider, request) => {
      const controller = new AbortController();
      const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
      const pending = request(transport, controller.signal);
      const outcome = pending.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
      controller.abort(null);
      const result = await Promise.race([
        outcome,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("stalled"), 100),
        ),
      ]);
      expect(result).toBe(null);
      expect(transport.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    },
  );

  it.each(providers)(
    "%s stops waiting for an uncooperative JSON body",
    async (_provider, request) => {
      const controller = new AbortController();
      const response = new Response("private");
      const json = vi
        .spyOn(response, "json")
        .mockImplementation(() => new Promise(() => {}));
      const cancel = vi.spyOn(response.body!, "cancel");
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      const pending = request(transport, controller.signal);
      const outcome = pending.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
      controller.abort(null);
      const result = await Promise.race([
        outcome,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("stalled"), 100),
        ),
      ]);
      expect(result).toBe(null);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

describe("xAI speech response privacy", () => {
  it("does not dispatch a pre-aborted speech request", async () => {
    const controller = new AbortController();
    controller.abort(null);
    const transport = vi.fn<typeof fetch>();
    await expect(
      xaiGenerateSpeech({
        apiKey: "secret",
        text: "private",
        signal: controller.signal,
        customFetch: transport,
      }),
    ).rejects.toBe(null);
    expect(transport).not.toHaveBeenCalled();
  });

  it("stops waiting for an uncooperative audio read on cancellation", async () => {
    const controller = new AbortController();
    const response = new Response("private");
    const reading = vi
      .spyOn(response, "arrayBuffer")
      .mockImplementation(() => new Promise(() => {}));
    const cancel = vi.spyOn(response.body!, "cancel");
    const pending = xaiGenerateSpeech({
      apiKey: "secret",
      text: "private",
      signal: controller.signal,
      customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    controller.abort(null);
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("stalled"), 100),
      ),
    ]);
    expect(result).toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a real stalled audio response body on abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = xaiGenerateSpeech({
      apiKey: "secret",
      text: "private",
      signal: controller.signal,
      customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns successful audio bytes unchanged", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const result = await xaiGenerateSpeech({
      apiKey: "secret",
      text: "private",
      signal: new AbortController().signal,
      customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
  });

  it("preserves abort identity without exposing body-read details", async () => {
    const response = new Response("unused");
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(
      new DOMException("private words", "AbortError"),
    );
    await expect(
      xaiGenerateSpeech({
        apiKey: "secret",
        text: "private words",
        customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "xAI speech response cancelled",
    });
  });

  it("fails closed when a body-read error has a throwing name accessor", async () => {
    const response = new Response("unused");
    const error = new Error("unused");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("private accessor fragment");
      },
    });
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(error);
    const result = await xaiGenerateSpeech({
      apiKey: "secret",
      text: "private",
      customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    }).catch((caught: unknown) => caught);
    expect(String(result)).toBe("Error: xAI speech response could not be read");
  });

  it("does not expose fragments from a failed audio body read", async () => {
    const response = new Response("unused");
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(
      new Error("private words from response"),
    );
    const error = await xaiGenerateSpeech({
      apiKey: "secret",
      text: "private words",
      customFetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private words");
  });
});

describe("provider HTTP errors", () => {
  it.each([
    [
      "Aldea",
      () => {
        vi.stubGlobal("fetch", vi.fn(sensitiveErrorResponse));
        return aldeaTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: audio,
        });
      },
      "Aldea API request failed with status 401",
    ],
    [
      "Deepgram",
      () =>
        deepgramTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: audio,
          ext: "wav",
          customFetch: vi.fn(sensitiveErrorResponse),
        }),
      "Deepgram transcription request failed with status 401",
    ],
    [
      "ElevenLabs",
      () =>
        elevenlabsTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: audio,
          ext: "wav",
          customFetch: vi.fn(sensitiveErrorResponse),
        }),
      "ElevenLabs API request failed with status 401",
    ],
    [
      "xAI speech-to-text",
      () =>
        xaiTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: audio,
          ext: "wav",
          customFetch: vi.fn(sensitiveErrorResponse),
        }),
      "xAI STT request failed with status 401",
    ],
    [
      "xAI text-to-speech",
      () =>
        xaiGenerateSpeech({
          apiKey: "example-opaque-secret",
          text: "hello",
          customFetch: vi.fn(errorResponse),
        }),
      "xAI TTS request failed with status 401",
    ],
  ])(
    "%s preserves its message and retry metadata",
    async (_, call, message) => {
      await expect(call()).rejects.toMatchObject({
        name: "HttpError",
        status: 401,
        retryAfterMs: 1000,
        message,
      });
    },
  );

  it.each([
    ["ElevenLabs", elevenlabsTestIntegration],
    ["xAI", xaiTestIntegration],
  ])(
    "%s integration handles detailed and empty failures",
    async (provider, call) => {
      await expect(
        call({
          apiKey: "example-opaque-secret",
          customFetch: vi.fn(errorResponse),
        }),
      ).rejects.toMatchObject({
        status: 401,
        retryAfterMs: 1000,
        message: `${provider} responded 401: bad key`,
      });
      await expect(
        call({
          apiKey: "example-opaque-secret",
          customFetch: vi.fn(() =>
            Promise.resolve(new Response("", { status: 401 })),
          ),
        }),
      ).rejects.toMatchObject({
        message: `${provider} responded with status 401`,
      });
      await expect(
        call({
          apiKey: "example-opaque-secret",
          customFetch: vi.fn(() =>
            Promise.resolve(new Response("ok", { status: 200 })),
          ),
        }),
      ).resolves.toBe(true);
    },
  );

  it.each(["Aldea", "Deepgram", "ElevenLabs", "xAI"] as const)(
    "%s sends only the selected bytes of a pooled audio buffer",
    async (provider) => {
      const sliced = Buffer.from([99, 1, 2, 3, 88]).subarray(1, 4);
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, _init?: RequestInit) =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                text: "hello",
                results: {
                  channels: [{ alternatives: [{ transcript: "hello" }] }],
                },
              }),
            ),
          ),
      );
      if (provider === "Aldea") {
        vi.stubGlobal("fetch", fetchMock);
        await aldeaTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: sliced,
        });
      } else if (provider === "Deepgram") {
        await deepgramTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: sliced,
          ext: "wav",
          customFetch: fetchMock,
        });
      } else if (provider === "ElevenLabs") {
        await elevenlabsTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: sliced,
          ext: "wav",
          customFetch: fetchMock,
        });
      } else {
        await xaiTranscribeAudio({
          apiKey: "example-opaque-secret",
          blob: sliced,
          ext: "wav",
          customFetch: fetchMock,
        });
      }
      const body = fetchMock.mock.calls[0]?.[1]?.body;
      const audio =
        body instanceof FormData
          ? await (body.get("file") as File).arrayBuffer()
          : (body as ArrayBuffer);
      expect(Array.from(new Uint8Array(audio))).toEqual([1, 2, 3]);
    },
  );

  it("continues to parse successful Aldea and xAI responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: {
                channels: [{ alternatives: [{ transcript: "hello world" }] }],
              },
            }),
          ),
        ),
      ),
    );
    await expect(
      aldeaTranscribeAudio({ apiKey: "example-opaque-secret", blob: audio }),
    ).resolves.toEqual({ text: "hello world", wordsUsed: 2 });
    await expect(
      xaiTranscribeAudio({
        apiKey: "example-opaque-secret",
        blob: audio,
        ext: "wav",
        customFetch: vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ text: "hello world" })),
          ),
        ),
      }),
    ).resolves.toEqual({ text: "hello world", wordsUsed: 2 });
  });
});

describe("provider response credential privacy", () => {
  const secret = "opaque_provider_credential_8472";
  const fail = () =>
    Promise.resolve(
      new Response(`Refused credential ${secret}`, { status: 401 }),
    );
  const customFetch = vi.fn(fail);

  it.each([
    [
      "Aldea transcription",
      () => {
        vi.stubGlobal("fetch", vi.fn(fail));
        return aldeaTranscribeAudio({ apiKey: secret, blob: audio });
      },
    ],
    [
      "Deepgram transcription",
      () =>
        deepgramTranscribeAudio({
          apiKey: secret,
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs transcription",
      () =>
        elevenlabsTranscribeAudio({
          apiKey: secret,
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "ElevenLabs integration",
      () => elevenlabsTestIntegration({ apiKey: secret, customFetch }),
    ],
    [
      "xAI transcription",
      () =>
        xaiTranscribeAudio({
          apiKey: secret,
          blob: audio,
          ext: "wav",
          customFetch,
        }),
    ],
    [
      "xAI speech",
      () => xaiGenerateSpeech({ apiKey: secret, text: "hello", customFetch }),
    ],
    [
      "xAI integration",
      () => xaiTestIntegration({ apiKey: secret, customFetch }),
    ],
  ])("%s does not echo its API credential", async (provider, run) => {
    const error = await run().then(
      () => {
        throw new Error("expected request to reject");
      },
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ name: "HttpError", status: 401 });
    expect(String(error)).not.toContain(secret);
    if (provider.endsWith("integration")) {
      expect(String(error)).toContain("[redacted]");
    } else {
      expect(String(error)).not.toContain("Refused credential");
    }
  });
});

it("does not expose submitted speech text in an xAI TTS rejection", async () => {
  const privateText = "confidential spoken phrase";
  const customFetch = vi.fn(() =>
    Promise.resolve(
      new Response(`Invalid input: ${privateText}`, { status: 400 }),
    ),
  );
  const error = await xaiGenerateSpeech({
    apiKey: "opaque-secret",
    text: privateText,
    customFetch,
  }).then(
    () => {
      throw new Error("expected failure");
    },
    (reason: unknown) => reason,
  );
  expect(String(error)).not.toContain(privateText);
  expect(error).toMatchObject({ name: "HttpError", status: 400 });
});

it("does not expose partial submitted speech text in an xAI TTS rejection", async () => {
  const privateText = "confidential spoken phrase with sensitive details";
  const customFetch = vi.fn(() =>
    Promise.resolve(
      new Response("Invalid input near: confidential spoken phrase", {
        status: 400,
      }),
    ),
  );
  const error = await xaiGenerateSpeech({
    apiKey: "opaque-secret",
    text: privateText,
    customFetch,
  }).then(
    () => {
      throw new Error("expected failure");
    },
    (reason: unknown) => reason,
  );
  expect(String(error)).not.toContain("confidential spoken phrase");
  expect(error).toMatchObject({ name: "HttpError", status: 400 });
});

it.each(["Aldea", "Deepgram", "ElevenLabs", "xAI"] as const)(
  "%s does not expose malformed successful response text",
  async (provider) => {
    const privateFragment = "private-transcript-fragment";
    const customFetch = vi.fn(() =>
      Promise.resolve(new Response(privateFragment)),
    );
    let call: Promise<unknown>;
    if (provider === "Aldea") {
      vi.stubGlobal("fetch", customFetch);
      call = aldeaTranscribeAudio({ apiKey: "test", blob: audio });
    } else if (provider === "Deepgram") {
      call = deepgramTranscribeAudio({
        apiKey: "test",
        blob: audio,
        ext: "wav",
        customFetch,
      });
    } else if (provider === "ElevenLabs") {
      call = elevenlabsTranscribeAudio({
        apiKey: "test",
        blob: audio,
        ext: "wav",
        customFetch,
      });
    } else {
      call = xaiTranscribeAudio({
        apiKey: "test",
        blob: audio,
        ext: "wav",
        customFetch,
      });
    }
    const error = await call.then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateFragment);
    expect(String(error)).not.toContain("private-tr");
    expect((error as Error).message).toBe(
      `${provider} response could not be decoded`,
    );
  },
);
