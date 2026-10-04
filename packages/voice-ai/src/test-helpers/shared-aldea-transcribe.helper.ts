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

    async function runTestCase(
      transcript: string,
      params: Record<string, unknown>,
    ) {
      const fetchMock = buildFetchMock(transcript);

      const mod = await loadModule();
      const fn = mod[functionName] as (
        params: Record<string, unknown>,
      ) => Promise<{ text: string }>;

      const result = await fn(params);

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      const requestUrl = new URL(String(url));

      return { result, requestUrl, init };
    }

    it("forwards a non-auto language as a query parameter", async () => {
      const { result, requestUrl, init } = await runTestCase("你好世界", {
        apiKey: "aldea-key",
        blob: new ArrayBuffer(8),
        language: "zh",
      });

      expect(result.text).toBe("你好世界");
      expect(init?.method).toBe("POST");
      expect(requestUrl.origin + requestUrl.pathname).toBe(
        "https://api.aldea.ai/v1/listen",
      );
      expect(requestUrl.searchParams.get("language")).toBe("zh");
    });

    it("preserves regional language variants like zh-CN", async () => {
      const { requestUrl } = await runTestCase("你好", {
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
        language: "zh-CN",
      });

      expect(requestUrl.searchParams.get("language")).toBe("zh-CN");
    });

    it("omits the language query parameter when language is auto", async () => {
      const { requestUrl } = await runTestCase("hello world", {
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
        language: "auto",
      });

      expect(requestUrl.searchParams.has("language")).toBe(false);
    });

    it("omits the language query parameter when no language is provided", async () => {
      const { requestUrl } = await runTestCase("hi", {
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
      });

      expect(requestUrl.searchParams.has("language")).toBe(false);
    });
  });
}
