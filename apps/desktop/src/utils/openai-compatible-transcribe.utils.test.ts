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
      model: "whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

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
  });
});
