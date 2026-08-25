import { afterEach, describe, expect, it, vi } from "vitest";
import { aldeaTranscribeAudio } from "../src/aldea.utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aldeaTranscribeAudio", () => {
  it("forwards a non-auto language as a query parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "你好世界" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await aldeaTranscribeAudio({
      apiKey: "aldea-key",
      blob: new ArrayBuffer(8),
      language: "zh",
    });

    expect(result.text).toBe("你好世界");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      "https://api.aldea.ai/v1/listen",
    );
    expect(requestUrl.searchParams.get("language")).toBe("zh");
  });

  it("preserves regional language variants like zh-CN", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "你好" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await aldeaTranscribeAudio({
      apiKey: "aldea-key",
      blob: new ArrayBuffer(4),
      language: "zh-CN",
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));
    expect(requestUrl.searchParams.get("language")).toBe("zh-CN");
  });

  it("omits the language query parameter when language is auto", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "hello world" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await aldeaTranscribeAudio({
      apiKey: "aldea-key",
      blob: new ArrayBuffer(4),
      language: "auto",
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));
    expect(requestUrl.searchParams.has("language")).toBe(false);
  });

  it("omits the language query parameter when no language is provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "hi" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await aldeaTranscribeAudio({
      apiKey: "aldea-key",
      blob: new ArrayBuffer(4),
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));
    expect(requestUrl.searchParams.has("language")).toBe(false);
  });
});
