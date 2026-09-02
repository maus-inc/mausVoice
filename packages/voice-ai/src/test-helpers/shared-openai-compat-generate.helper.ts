import { afterEach, describe, expect, it, vi } from "vitest";

export function createOpenAICompatibleGenerateTests({
  describeName,
  loadModule,
  functionName,
  defaultModel,
  expectedDefaultMaxTokens = 1024,
  expectedForwardedMaxTokens = 600,
  mockFactory = buildDefaultMockFactory,
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  defaultModel: string;
  expectedDefaultMaxTokens?: number;
  expectedForwardedMaxTokens?: number;
  mockFactory?: () => Record<string, unknown>;
}) {
  describe(describeName, () => {
    afterEach(() => {
      vi.doUnmock("openai");
      vi.resetModules();
    });

    const buildCreateCompletion = (
      content: string,
      usage = { total_tokens: 5 },
    ) =>
      vi.fn().mockResolvedValue({
        choices: [{ message: { content } }],
        usage,
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
          },
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName] as (params: Record<string, unknown>) => Promise<unknown>;

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
      });

      expect(createCompletion).toHaveBeenCalledTimes(1);
      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        max_completion_tokens: expectedDefaultMaxTokens,
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
      });

      expect(createCompletion).toHaveBeenCalledTimes(1);
      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        max_completion_tokens: expectedForwardedMaxTokens,
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
      });

      expect(createCompletion.mock.calls[0][0]).toMatchObject({
        response_format: { type: "json_object" },
      });
      const sentMessages = createCompletion.mock.calls[0][0]?.messages as
        | Array<{
            content: string | Array<{ type: string; text: string }>;
          }>
        | undefined;
      const userContent = sentMessages?.[0]?.content;
      const userText = Array.isArray(userContent)
        ? userContent.map((p) => p.text).join("")
        : String(userContent);
      expect(userText).toContain(JSON.stringify(baseJsonResponse.schema));
    });

    it("omits response_format when jsonResponse is not set", async () => {
      const createCompletion = buildCreateCompletion("ok");

      const { createCompletion: cc } = await runTestCase(createCompletion, {
        apiKey: "test-key",
        model: defaultModel,
        prompt: "hi",
      });

      expect(createCompletion.mock.calls[0][0]?.response_format).toBeUndefined();
    });
  });
}

export function buildDefaultMockFactory() {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
    },
  };
}
