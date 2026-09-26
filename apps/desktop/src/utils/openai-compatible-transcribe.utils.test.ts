import { HttpError, retry } from "@maus-inc/utilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

import { openaiCompatibleTranscribeAudio } from "./openai-compatible-transcribe.utils";

const makeResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const transcribe = () =>
  openaiCompatibleTranscribeAudio({
    baseUrl: "https://example.com/v1",
    model: "whisper-1",
    blob: new ArrayBuffer(8),
    ext: "wav",
  });

// A Response body is a single-use stream and the retry policy resends the same
// request, so every attempt needs a Response of its own.
const respondWith = (body: string, status: number, headers?: HeadersInit) =>
  fetchMock.mockImplementation(
    async () => new Response(body, { status, headers }),
  );

const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const requestBodyAt = (index: number): FormData => {
  const init = fetchMock.mock.calls[index]?.[1];
  if (init == null || !(init.body instanceof FormData)) {
    throw new Error(`expected FormData body at call ${index}`);
  }
  return init.body;
};

describe("openaiCompatibleTranscribeAudio", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("uses the custom transcription path when provided", async () => {
    fetchMock.mockResolvedValue(makeResponse({ text: "hello world" }));

    await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
      transcriptionPath: "/custom/transcriptions",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    // The custom path replaces the default /audio/transcriptions suffix
    // while staying under the versioned base (/v1) built by the repo.
    expect(url).toBe("https://example.com/v1/custom/transcriptions");
  });

  it("defaults to the /v1/audio/transcriptions path when omitted", async () => {
    fetchMock.mockResolvedValue(makeResponse({ text: "hello world" }));

    await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/v1/audio/transcriptions");
  });

  it("prefers verbose_json so capable servers return no_speech_prob segments", async () => {
    fetchMock.mockResolvedValue(makeResponse({ text: "hello world" }));

    const result = await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    expect(result.text).toBe("hello world");
    expect(requestBodyAt(0).get("response_format")).toBe("verbose_json");
  });

  it("falls back to json when the server rejects verbose_json with a 4xx", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Invalid response_format verbose_json" }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(makeResponse({ text: "recovered text" }));

    const result = await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyAt(0).get("response_format")).toBe("verbose_json");
    expect(requestBodyAt(1).get("response_format")).toBe("json");
    expect(result.text).toBe("recovered text");
  });

  it("falls back to no response_format when json is also rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Invalid response_format verbose_json" }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Invalid response_format json" }),
          {
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(makeResponse({ text: "recovered text" }));

    const result = await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      (fetchMock.mock.calls[0]![1]!.body as FormData).get("response_format"),
    ).toBe("verbose_json");
    expect(
      (fetchMock.mock.calls[1]![1]!.body as FormData).get("response_format"),
    ).toBe("json");
    expect(
      (fetchMock.mock.calls[2]![1]!.body as FormData).get("response_format"),
    ).toBeNull();
    expect(result.text).toBe("recovered text");
  });

  it("does not retry on an unrelated 4xx error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }),
    );

    await expect(
      openaiCompatibleTranscribeAudio({
        baseUrl: "https://example.com/v1",
        model: "whisper-1",
        apiKey: "bad",
        blob: new ArrayBuffer(8),
        ext: "wav",
      }),
    ).rejects.toThrow(/401 - .*Unauthorized/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the server error body for a 5xx failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Service Unavailable - try again later" }),
        { status: 503 },
      ),
    );

    await expect(
      openaiCompatibleTranscribeAudio({
        baseUrl: "https://example.com/v1",
        model: "whisper-1",
        blob: new ArrayBuffer(8),
        ext: "wav",
      }),
    ).rejects.toThrow(/503 - .*Service Unavailable/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("openaiCompatibleTranscribeAudio reports the status as data", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attempts a terminal status exactly once and keeps the existing message", async () => {
    respondWith(JSON.stringify({ error: "quota exhausted" }), 402);

    const error = await settled(retry({ fn: transcribe }));

    // A rejected quota cannot clear on a second identical upload, so the
    // attempt count is the behaviour that matters and is checked first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(402);
    expect((error as HttpError).retryAfterMs).toBeNull();
    // The message is what a caller shows and what the assertions above pin, so
    // it has to stay byte-identical to the plain Error it replaced.
    expect((error as Error).message).toBe(
      'OpenAI Compatible transcription failed: 402 - {"error":"quota exhausted"}',
    );
  });

  it("waits out a rate-limit hint and retries instead of failing at once", async () => {
    vi.useFakeTimers();
    respondWith("slow down", 429, { "retry-after": "1" });

    const attempt = settled(retry({ fn: transcribe }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The hint sets the pace, so the second attempt must not run on the
    // helper's own 20ms floor.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await attempt;

    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).retryAfterMs).toBe(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clamps a long rate-limit hint to the interactive cap", async () => {
    vi.useFakeTimers();
    respondWith("slow down", 503, { "retry-after": "60" });

    const attempt = settled(retry({ fn: transcribe }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // DEFAULT_MAX_RETRY_DELAY_MS is 2s, so a person waiting on a dictation gets
    // the 2s ceiling rather than the full minute the header asked for.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000);
    const error = await attempt;

    expect((error as HttpError).status).toBe(503);
    // The hint is parsed in full; only the wait is capped.
    expect((error as HttpError).retryAfterMs).toBe(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a 2xx body with no text a plain error", async () => {
    respondWith(JSON.stringify({}), 200);

    const error = await settled(transcribe());

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toBe(
      "Transcription failed: no text in response",
    );
  });
});
