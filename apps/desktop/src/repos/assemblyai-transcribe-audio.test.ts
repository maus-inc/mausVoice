import {
  jsonResponse,
  mockAssemblyAITranscription,
} from "../../test/helpers/assemblyai-fetch-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assemblyaiTestIntegration,
  assemblyaiTranscribeAudio,
} from "@maus-inc/voice-ai";

const UPLOAD_URL = "https://cdn.assemblyai.com/upload/abc123";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("assemblyaiTranscribeAudio", () => {
  it("uploads raw bytes with the token header and returns the completed text", async () => {
    const requests = mockAssemblyAITranscription("hello");

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: Buffer.from([1, 2, 3, 4]),
    });

    expect(text).toBe("hello");
    expect(requests.uploadInit?.method).toBe("POST");
    expect(requests.uploadInit?.headers).toMatchObject({
      Authorization: "aa-key",
      "Content-Type": "application/octet-stream",
    });
    // Buffer payloads are converted to a raw ArrayBuffer before upload.
    expect(requests.uploadInit?.body).toBeInstanceOf(ArrayBuffer);
  });

  it("sends language_code and omits language_detection for an explicit language", async () => {
    const requests = mockAssemblyAITranscription("bonjour");

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
      language: "fr",
    });

    expect(text).toBe("bonjour");
    expect(requests.createBody).toEqual({
      audio_url: UPLOAD_URL,
      language_code: "fr",
    });
  });

  it("omits language_code and requests detection when language is not provided", async () => {
    const requests = mockAssemblyAITranscription("hola");

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("hola");
    expect(requests.createBody).toEqual({
      audio_url: UPLOAD_URL,
      language_detection: true,
    });
    expect(requests.createBody).not.toHaveProperty("language_code");
  });

  it("surfaces upload HTTP failures without retrying non-transient 4xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/AssemblyAI upload failed: 401/);

    // A 401 is a credentials problem; retrying cannot fix it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing upload URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v2/upload")) {
        return jsonResponse({});
      }
      return jsonResponse({}, 404);
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/no audio URL/);
  });

  it("surfaces transcript-request HTTP failures without retrying non-transient 4xx", async () => {
    let transcriptRequestCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      transcriptRequestCalls++;
      return new Response("bad request", { status: 400 });
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/transcript request failed: 400/);

    // A 400 is a malformed request; retrying cannot fix it.
    expect(transcriptRequestCalls).toBe(1);
  });

  it("surfaces transcript errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({
        id: "t1",
        status: "error",
        error: "audio too quiet",
      });
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/transcription failed: audio too quiet/);
  });

  it("times out when the transcript never completes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({ id: "t1", status: "queued" });
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
        timeoutMs: 120,
        pollIntervalMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("retries a transient upload failure", async () => {
    const requests = mockAssemblyAITranscription("retried", {
      upload: (_init, attempt) => {
        if (attempt === 1) {
          return new Response("upstream blip", { status: 502 });
        }
      },
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("retried");
    expect(requests.calls.upload).toBeGreaterThanOrEqual(2);
  });

  it("retries a transient status-poll failure", async () => {
    const requests = mockAssemblyAITranscription("recovered", {
      status: (_init, attempt) => {
        if (attempt === 1) {
          return new Response("upstream blip", { status: 502 });
        }
      },
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("recovered");
    expect(requests.calls.status).toBeGreaterThanOrEqual(2);
  });

  it("honors Retry-After when retrying a 429 response", async () => {
    const requests = mockAssemblyAITranscription("rate recovered", {
      upload: (_init, attempt) => {
        if (attempt === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
      },
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("rate recovered");
    expect(requests.calls.upload).toBe(2);
  });

  it("honors an HTTP-date Retry-After header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    const requests = mockAssemblyAITranscription("date retried", {
      upload: (_init, attempt) => {
        if (attempt === 1) {
          // RFC 7231 allows an absolute date; the retry must wait until then
          // instead of falling back to exponential backoff.
          const retryAt = new Date(Date.now() + 2000).toUTCString();
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": retryAt },
          });
        }
      },
    });

    const pending = assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(requests.calls.upload).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const { text } = await pending;
    expect(text).toBe("date retried");
    expect(requests.calls.upload).toBe(2);
  });

  it("prefixes the error label when retries are exhausted on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/AssemblyAI upload failed: fetch failed/);
  });

  it("drains the response body before retrying a transient failure", async () => {
    let firstBodyDrained = false;
    const requests = mockAssemblyAITranscription("drained retried", {
      upload: (_init, attempt) => {
        if (attempt === 1) {
          const response = new Response("upstream blip", { status: 502 });
          // Simulate an undici-style runtime: the connection is only released
          // once the body is consumed. Track consumption to assert the retry
          // path drains it.
          const originalText = response.text.bind(response);
          response.text = async () => {
            firstBodyDrained = true;
            return originalText();
          };
          return response;
        }
      },
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("drained retried");
    expect(requests.calls.upload).toBe(2);
    expect(firstBodyDrained).toBe(true);
  });

  it.each(["upload", "create", "status"] as const)(
    "aborts a %s request that never settles and reports a timeout",
    async (stage) => {
      mockAssemblyAITranscription("unreachable", {
        [stage]: (init: RequestInit | undefined) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      });
      const startedAt = Date.now();
      await expect(
        assemblyaiTranscribeAudio({
          apiKey: "aa-key",
          blob: new ArrayBuffer(8),
          timeoutMs: 150,
          pollIntervalMs: 20,
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    },
  );

  it("surfaces a clean error when the upload response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>proxy error</html>", { status: 200 }),
    );

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/AssemblyAI upload failed: response was not valid JSON/);
  });

  it("surfaces a clean error when the transcript-create response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      return new Response("<html>proxy error</html>", { status: 200 });
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(
      /AssemblyAI transcript request failed: response was not valid JSON/,
    );
  });

  it("surfaces a clean error when the status response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return new Response("<html>proxy error</html>", { status: 200 });
    });

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(
      /AssemblyAI transcript status failed: response was not valid JSON/,
    );
  });

  it("rejects invalid timeout and poll-interval options before any network call", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ upload_url: UPLOAD_URL }));

    const base = { apiKey: "aa-key", blob: new ArrayBuffer(8) };

    await expect(
      assemblyaiTranscribeAudio({ ...base, timeoutMs: 0 }),
    ).rejects.toThrow(/timeout must be a positive finite number/);
    await expect(
      assemblyaiTranscribeAudio({ ...base, timeoutMs: Number.NaN }),
    ).rejects.toThrow(/timeout must be a positive finite number/);
    await expect(
      assemblyaiTranscribeAudio({ ...base, pollIntervalMs: -1 }),
    ).rejects.toThrow(/poll interval must be a positive finite number/);

    // Validation happens before any request is issued.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the Universal-2 fallback pair when Universal-3.5 Pro is selected", async () => {
    const requests = mockAssemblyAITranscription();

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      model: "universal-3-5-pro",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("hi");
    expect(requests.createBody).toMatchObject({
      audio_url: UPLOAD_URL,
      speech_models: ["universal-3-5-pro", "universal-2"],
    });
  });

  it("sends only Universal-2 when Universal-2 is selected", async () => {
    const requests = mockAssemblyAITranscription();

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      model: "universal-2",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("hi");
    expect(requests.createBody).toMatchObject({
      audio_url: UPLOAD_URL,
      speech_models: ["universal-2"],
    });
  });

  it.each([
    ["best", ["universal-3-5-pro", "universal-2"]],
    ["nano", ["universal-2"]],
  ] as const)(
    "migrates the legacy %s tier to its successor",
    async (model, expected) => {
      const requests = mockAssemblyAITranscription();

      await assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        model,
        blob: new ArrayBuffer(8),
      });

      expect(requests.createBody).toMatchObject({
        audio_url: UPLOAD_URL,
        speech_models: expected,
      });
    },
  );

  it("omits speech_models when no model is selected", async () => {
    const requests = mockAssemblyAITranscription();

    await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(requests.createBody).not.toHaveProperty("speech_models");
  });

  it("rejects an unknown speech model before any network call", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ upload_url: UPLOAD_URL }));

    await expect(
      assemblyaiTranscribeAudio({
        apiKey: "aa-key",
        model: "whisper-1",
        blob: new ArrayBuffer(8),
      }),
    ).rejects.toThrow(/Unknown AssemblyAI speech model "whisper-1"/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("assemblyaiTestIntegration", () => {
  it("validates the API key without any network call when the model is unknown", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      assemblyaiTestIntegration({ apiKey: "aa-key", model: "whisper-1" }),
    ).rejects.toThrow(/Unknown AssemblyAI speech model "whisper-1"/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("migrates a legacy model instead of failing the key test", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );

    await expect(
      assemblyaiTestIntegration({ apiKey: "aa-key", model: "best" }),
    ).resolves.toBe(true);
    await expect(
      assemblyaiTestIntegration({ apiKey: "aa-key", model: "nano" }),
    ).resolves.toBe(true);
  });

  it("validates the API key when the selected model is supported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );

    await expect(
      assemblyaiTestIntegration({
        apiKey: "aa-key",
        model: "universal-3-5-pro",
      }),
    ).resolves.toBe(true);
  });

  it("still validates the API key when no model is selected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );

    await expect(assemblyaiTestIntegration({ apiKey: "aa-key" })).resolves.toBe(
      true,
    );
  });
});
