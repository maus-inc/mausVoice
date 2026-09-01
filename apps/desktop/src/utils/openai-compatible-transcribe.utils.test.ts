<<<<<<< HEAD
import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetchResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

const mockTauriFetch = (spy: ReturnType<typeof vi.fn>) => {
  vi.doMock("@tauri-apps/plugin-http", () => ({
    fetch: spy,
  }));
};

const loadModule = async () => {
  const mod = await import("./openai-compatible-transcribe.utils");
  return mod.openaiCompatibleTranscribeAudio;
};

afterEach(() => {
  vi.doUnmock("@tauri-apps/plugin-http");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("openaiCompatibleTranscribeAudio", () => {
  it("posts to the default /audio/transcriptions path when no override is given", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ text: "hello" }));
    mockTauriFetch(fetchSpy);

    const transcribe = await loadModule();
    await transcribe({
      baseUrl: "http://localhost:8080/v1",
=======
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

import { openaiCompatibleTranscribeAudio } from "./openai-compatible-transcribe.utils";

const makeResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe("openaiCompatibleTranscribeAudio", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("prefers verbose_json so capable servers return no_speech_prob segments", async () => {
    fetchMock.mockResolvedValue(makeResponse({ text: "hello world" }));

    const result = await openaiCompatibleTranscribeAudio({
      baseUrl: "https://example.com/v1",
>>>>>>> origin/fix/superfix-review-findings
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

<<<<<<< HEAD
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://localhost:8080/v1/audio/transcriptions");
  });

  it("replaces the trailing path with a custom transcription path", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ text: "hello" }));
    mockTauriFetch(fetchSpy);

    const transcribe = await loadModule();
    await transcribe({
      baseUrl: "http://localhost:8080/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
      transcriptionPath: "/v1/listen",
    });

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://localhost:8080/v1/v1/listen");
  });

  it("normalizes a custom transcription path that does not start with /", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ text: "hi" }));
    mockTauriFetch(fetchSpy);

    const transcribe = await loadModule();
    await transcribe({
      baseUrl: "http://localhost:8080/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      transcriptionPath: "v1/audio/transcriptions",
    });

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://localhost:8080/v1/v1/audio/transcriptions");
  });

  it("trims whitespace from the transcription path override", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ text: "ok" }));
    mockTauriFetch(fetchSpy);

    const transcribe = await loadModule();
    await transcribe({
      baseUrl: "http://localhost:8080/v1",
      model: "whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      transcriptionPath: "  /v1/audio/transcriptions  ",
    });

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://localhost:8080/v1/v1/audio/transcriptions");
=======
    expect(result.text).toBe("hello world");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = init?.body as FormData;
    expect(body.get("response_format")).toBe("verbose_json");
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
    const [, firstInit] = fetchMock.mock.calls[0]!;
    const [, secondInit] = fetchMock.mock.calls[1]!;
    expect((firstInit!.body as FormData).get("response_format")).toBe(
      "verbose_json",
    );
    expect((secondInit!.body as FormData).get("response_format")).toBe("json");
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
>>>>>>> origin/fix/superfix-review-findings
  });
});
