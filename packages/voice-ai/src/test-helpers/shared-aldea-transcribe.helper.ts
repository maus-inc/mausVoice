import { afterEach, describe, expect, it, vi } from "vitest";

export function createAldeaTranscribeTests({
  describeName,
  loadModule,
  functionName,
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
}) {
  describe(describeName, () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const buildFetchMock = (transcript: string) =>
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  alternatives: [{ transcript }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

    it("forwards a non-auto language as a query parameter", async () => {
      const fetchMock = buildFetchMock("你好世界");

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<{ text: string }>;

      const result = await fn({
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
      const fetchMock = buildFetchMock("你好");

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<{ text: string }>;

      await fn({
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
        language: "zh-CN",
      });

      const [url] = fetchMock.mock.calls[0] ?? [];
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("language")).toBe("zh-CN");
    });

    it("omits the language query parameter when language is auto", async () => {
      const fetchMock = buildFetchMock("hello world");

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<{ text: string }>;

      await fn({
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
        language: "auto",
      });

      const [url] = fetchMock.mock.calls[0] ?? [];
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.has("language")).toBe(false);
    });

    it("omits the language query parameter when no language is provided", async () => {
      const fetchMock = buildFetchMock("hi");

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<{ text: string }>;

      await fn({
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
      });

      const [url] = fetchMock.mock.calls[0] ?? [];
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.has("language")).toBe(false);
    });
  });
}
