import { afterEach, describe, expect, it, vi } from "vitest";

export function createGeminiGenerateTests({
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
      vi.doUnmock("@google/genai");
      vi.resetModules();
    });

    const buildGenerateContent = () =>
      vi.fn().mockResolvedValue({
        text: "ok",
        usageMetadata: { totalTokenCount: 1 },
      });

    const buildMockFactory = () => ({
      GoogleGenAI: class MockGoogleGenAI {
        models = {
          generateContent: vi.fn(),
        };
      },
      Type: { STRING: "string" },
    });

    async function runTestCase(
      generateContent: ReturnType<typeof buildGenerateContent>,
      params: Record<string, unknown>,
    ) {
      vi.doMock("@google/genai", () => ({
        ...buildMockFactory(),
        GoogleGenAI: class MockGoogleGenAI {
          models = {
            generateContent,
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<unknown>;

      await fn(params);

      const callParams = generateContent.mock.calls[0][0];
      return { callParams };
    }

    it("omits maxOutputTokens from the config when maxTokens is undefined", async () => {
      const generateContent = buildGenerateContent();

      const { callParams } = await runTestCase(generateContent, {
        apiKey: "test-key",
        prompt: "hello",
      });

      expect(callParams.config).toBeUndefined();
    });

    it("forwards caller-owned maxTokens to config.maxOutputTokens when provided", async () => {
      const generateContent = buildGenerateContent();

      const { callParams } = await runTestCase(generateContent, {
        apiKey: "test-key",
        prompt: "hello",
        maxTokens: 600,
      });

      expect(callParams.config).toMatchObject({ maxOutputTokens: 600 });
    });
  });
}
