import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const buildCreateCompletion = (content: string, usage = { total_tokens: 5 }) =>
  vi.fn().mockResolvedValue({
    choices: [{ message: { content } }],
    usage,
  });

export function createOpenAICompatibleGenerateTests({
  describeName,
  loadModule,
  functionName,
  defaultModel,
  expectedDefaultMaxTokens = 1024,
  expectedForwardedMaxTokens = 600,
  expectedJsonResponseType = "json_object",
  maxTokensKey = "max_completion_tokens",
  extraParams = {},
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  defaultModel: string;
  expectedDefaultMaxTokens?: number;
  expectedForwardedMaxTokens?: number;
  expectedJsonResponseType?: "json_object" | "json_schema";
  maxTokensKey?: "max_completion_tokens" | "max_tokens" | "maxOutputTokens";
  extraParams?: Record<string, unknown>;
}) {
  describe(describeName, () => {
    beforeAll(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
    });

    const baseJsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    async function runTestCase(
      createCompletion: ReturnType<typeof buildCreateCompletion>,
      params: Record<string, unknown>,
    ) {
      vi.doMock("openai", () => ({
        default: class MockOpenAI {
          chat = {
            completions: {
              create: createCompletion,
            },
          };
        },
        AzureOpenAI: class MockAzureOpenAI {
          chat = {
            completions: {
              create: createCompletion,
            },
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName] as (
        params: Record<string, unknown>,
      ) => Promise<unknown>;

      await fn(params);

      return { createCompletion };
    }

    it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
      const createCompletion = buildCreateCompletion(
        JSON.stringify({ result: "ok" }),
      );

      const { createCompletion: cc } = await runTestCase(createCompletion, {
        apiKey: "test-key",
        model: defaultModel,
        prompt: "hello",
        ...extraParams,
      });

      expect(createCompletion).toHaveBeenCalledTimes(1);
      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        [maxTokensKey]: expectedDefaultMaxTokens,
      });
    });

    it("forwards caller-owned maxTokens to max_tokens when provided", async () => {
      const createCompletion = buildCreateCompletion(
        JSON.stringify({ result: "ok" }),
      );

      const { createCompletion: cc } = await runTestCase(createCompletion, {
        apiKey: "test-key",
        model: defaultModel,
        prompt: "hello",
        maxTokens: expectedForwardedMaxTokens,
        ...extraParams,
      });

      expect(createCompletion).toHaveBeenCalledTimes(1);
      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        [maxTokensKey]: expectedForwardedMaxTokens,
      });
    });

    it("uses json_object and injects schema into the prompt when jsonResponse is set", async () => {
      const createCompletion = buildCreateCompletion(
        JSON.stringify({ result: "ok" }),
      );

      const { createCompletion: cc } = await runTestCase(createCompletion, {
        apiKey: "test-key",
        model: defaultModel,
        prompt: "hi",
        jsonResponse: baseJsonResponse,
        ...extraParams,
      });

      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        response_format: { type: expectedJsonResponseType },
      });
    });

    it("omits response_format when jsonResponse is not set", async () => {
      const createCompletion = buildCreateCompletion("ok");

      const { createCompletion: cc } = await runTestCase(createCompletion, {
        apiKey: "test-key",
        model: defaultModel,
        prompt: "hi",
        ...extraParams,
      });

      expect(
        createCompletion.mock.calls[0][0]?.response_format,
      ).toBeUndefined();
    });
  });
}
