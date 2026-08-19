import { afterEach, describe, expect, it, vi } from "vitest";
import { assemblyaiTranscribeAudio } from "@maus-inc/voice-ai";

const UPLOAD_URL = "https://cdn.assemblyai.com/upload/abc123";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assemblyaiTranscribeAudio", () => {
  it("uploads raw bytes with the token header and returns the completed text", async () => {
    let uploadInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        uploadInit = init;
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({ id: "t1", status: "completed", text: "hello" });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: Buffer.from([1, 2, 3, 4]),
    });

    expect(text).toBe("hello");
    expect(uploadInit?.method).toBe("POST");
    expect(uploadInit?.headers).toMatchObject({
      Authorization: "aa-key",
      "Content-Type": "application/octet-stream",
    });
    // Buffer payloads are converted to a raw ArrayBuffer before upload.
    expect(uploadInit?.body).toBeInstanceOf(ArrayBuffer);
  });

  it("sends language_code and omits language_detection for an explicit language", async () => {
    let createBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({ id: "t1", status: "completed", text: "bonjour" });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
      language: "fr",
    });

    expect(text).toBe("bonjour");
    expect(createBody).toEqual({
      audio_url: UPLOAD_URL,
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_code: "fr",
    });
  });

  it("omits language_code and requests detection when language is not provided", async () => {
    let createBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({ id: "t1", status: "completed", text: "hola" });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("hola");
    expect(createBody).toEqual({
      audio_url: UPLOAD_URL,
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_detection: true,
    });
    expect(createBody).not.toHaveProperty("language_code");
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
    let uploadCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        uploadCalls++;
        if (uploadCalls === 1) {
          return new Response("upstream blip", { status: 502 });
        }
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({ id: "t1", status: "completed", text: "retried" });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("retried");
    expect(uploadCalls).toBeGreaterThanOrEqual(2);
  });

  it("retries a transient status-poll failure", async () => {
    let statusCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      statusCalls++;
      if (statusCalls === 1) {
        return new Response("upstream blip", { status: 502 });
      }
      return jsonResponse({ id: "t1", status: "completed", text: "recovered" });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("recovered");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it("honors Retry-After when retrying a 429 response", async () => {
    let uploadCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        uploadCalls++;
        if (uploadCalls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({
        id: "t1",
        status: "completed",
        text: "rate recovered",
      });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("rate recovered");
    expect(uploadCalls).toBe(2);
  });

  it("honors an HTTP-date Retry-After header", async () => {
    let uploadCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        uploadCalls++;
        if (uploadCalls === 1) {
          // RFC 7231 allows an absolute date; the retry must wait until then
          // instead of falling back to exponential backoff.
          const retryAt = new Date(Date.now() + 50).toUTCString();
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": retryAt },
          });
        }
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({
        id: "t1",
        status: "completed",
        text: "date retried",
      });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("date retried");
    expect(uploadCalls).toBe(2);
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
    let uploadCalls = 0;
    let firstBodyDrained = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        uploadCalls++;
        if (uploadCalls === 1) {
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
        return jsonResponse({ upload_url: UPLOAD_URL });
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse({ id: "t1", status: "queued" });
      }
      return jsonResponse({
        id: "t1",
        status: "completed",
        text: "drained retried",
      });
    });

    const { text } = await assemblyaiTranscribeAudio({
      apiKey: "aa-key",
      blob: new ArrayBuffer(8),
    });

    expect(text).toBe("drained retried");
    expect(uploadCalls).toBe(2);
    expect(firstBodyDrained).toBe(true);
  });

  it("aborts a status request that never settles and reports a timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/upload")) {
        return Promise.resolve(jsonResponse({ upload_url: UPLOAD_URL }));
      }
      if (url.endsWith("/v2/transcript")) {
        return Promise.resolve(jsonResponse({ id: "t1", status: "queued" }));
      }
      // The status request never settles on its own; it must be aborted when
      // the overall deadline expires.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
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
    // Must not hang beyond the configured budget.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("aborts an upload request that never settles and reports a timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      // The upload never settles; it must be aborted by the shared deadline
      // rather than hanging the whole operation.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
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
  });

  it("aborts a transcript-create request that never settles and reports a timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).endsWith("/v2/upload")) {
        return Promise.resolve(jsonResponse({ upload_url: UPLOAD_URL }));
      }
      // The create never settles; it must be aborted by the shared deadline.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
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
  });

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
});
