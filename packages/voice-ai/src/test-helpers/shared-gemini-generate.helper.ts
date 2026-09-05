import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type GeminiTestDeps = {
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  fetchMock: ReturnType<typeof vi.fn>;
  respond: () => Response | Promise<Response>;
  extraParams: Record<string, unknown>;
};

async function runGeminiTestCase(
  { loadModule, functionName, fetchMock, respond, extraParams }: GeminiTestDeps,
  params: Record<string, unknown>,
) {
  const mod = await loadModule();
  const fn = mod[functionName] as (
    params: Record<string, unknown>,
  ) => Promise<unknown>;

  fetchMock.mockImplementation(respond);

  await fn({ ...extraParams, ...params });

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  const body = typeof init?.body === "string" ? init.body : undefined;

  return { callParams: body ? JSON.parse(body) : undefined };
}

export function createGeminiGenerateTests({
  describeName,
  loadModule,
  functionName,
  fetchMock,
  respond,
  extraParams = {},
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  fetchMock: ReturnType<typeof vi.fn>;
  respond: () => Response | Promise<Response>;
  extraParams?: Record<string, unknown>;
}) {
  describe(describeName, () => {
    beforeAll(() => {
      vi.resetModules();
    });

    afterEach(() => {
      fetchMock.mockReset();
      vi.resetModules();
    });

    const runTestCase = (params: Record<string, unknown>) =>
      runGeminiTestCase(
        { loadModule, functionName, fetchMock, respond, extraParams },
        params,
      );

    it("omits maxOutputTokens from the config when maxTokens is undefined", async () => {
      const { callParams } = await runTestCase({
        apiKey: "test-key",
        prompt: "hello",
      });

      expect(callParams?.generationConfig).toBeUndefined();
    });

    it("forwards caller-owned maxTokens to config.maxOutputTokens when provided", async () => {
      const { callParams } = await runTestCase({
        apiKey: "test-key",
        prompt: "hello",
        maxTokens: 600,
      });

      expect(callParams?.generationConfig).toMatchObject({
        maxOutputTokens: 600,
      });
    });
  });
}
