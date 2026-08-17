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

  it("defaults to response_format=json (not verbose_json)", async () => {
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
    expect(body.get("response_format")).toBe("json");
  });

  it("retries once without response_format when the server rejects the format", async () => {
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
    const [, firstInit] = fetchMock.mock.calls[0] ?? [];
    const [, secondInit] = fetchMock.mock.calls[1] ?? [];
    expect((firstInit?.body as FormData).get("response_format")).toBe("json");
    expect((secondInit?.body as FormData).get("response_format")).toBeNull();
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
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
