import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

export function createGeminiGenerateTests({
  describeName,
  loadModule,
  functionName,
  generateContentMock,
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  generateContentMock: ReturnType<typeof vi.fn>;
}) {
  describe(describeName, () => {
    beforeAll(() => {
      vi.resetModules();
    });

    afterEach(() => {
      generateContentMock.mockReset();
      vi.resetModules();
    });

    async function runTestCase(params: Record<string, unknown>) {
      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<unknown>;

      await fn(params);

      const callParams = generateContentMock.mock.calls[0][0];
      return { callParams };
    }

    it("omits maxOutputTokens from the config when maxTokens is undefined", async () => {
      generateContentMock.mockResolvedValue({
        text: "ok",
        usageMetadata: { totalTokenCount: 1 },
      });

      const { callParams } = await runTestCase({
        apiKey: "test-key",
        prompt: "hello",
      });

      expect(callParams.config).toBeUndefined();
    });

    it("forwards caller-owned maxTokens to config.maxOutputTokens when provided", async () => {
      generateContentMock.mockResolvedValue({
        text: "ok",
        usageMetadata: { totalTokenCount: 1 },
      });

      const { callParams } = await runTestCase({
        apiKey: "test-key",
        prompt: "hello",
        maxTokens: 600,
      });

      expect(callParams.config).toMatchObject({ maxOutputTokens: 600 });
    });
  });
}
