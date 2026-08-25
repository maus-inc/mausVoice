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
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

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
  });
});
