import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

export function createAnthropicGenerateTests({
  describeName,
  loadModule,
  functionName,
  defaultMaxTokens,
  forwardedMaxTokens,
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  defaultMaxTokens: number;
  forwardedMaxTokens: number;
}) {
  describe(describeName, () => {
    beforeAll(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
      vi.doUnmock("@anthropic-ai/sdk");
    });

    const buildCreateMessage = (text = "ok") =>
      vi.fn().mockResolvedValue({
        content: [{ type: "text", text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    async function runTestCase(
      createMessage: ReturnType<typeof buildCreateMessage>,
      params: Record<string, unknown>,
    ) {
      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = {
            create: createMessage,
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName] as (
        params: Record<string, unknown>,
      ) => Promise<unknown>;

      await fn(params);

      return { createMessage };
    }

    it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
      const createMessage = buildCreateMessage();

      await runTestCase(createMessage, {
        apiKey: "test-key",
        prompt: "hello",
      });

      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage.mock.calls[0][0]).toMatchObject({
        max_tokens: defaultMaxTokens,
      });
    });

    it("forwards caller-owned maxTokens to max_tokens when provided", async () => {
      const createMessage = buildCreateMessage();

      await runTestCase(createMessage, {
        apiKey: "test-key",
        prompt: "hello",
        maxTokens: forwardedMaxTokens,
      });

      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage.mock.calls[0][0]).toMatchObject({
        max_tokens: forwardedMaxTokens,
      });
    });

    it("injects the schema into the prompt when jsonResponse is set", async () => {
      const createMessage = buildCreateMessage("ok");

      const jsonResponse = {
        name: "schema",
        description: "x",
        schema: {
          type: "object" as const,
          properties: { result: { type: "string" as const } },
          required: ["result"],
        },
      };

      await runTestCase(createMessage, {
        apiKey: "test-key",
        prompt: "transcribe this",
        jsonResponse,
      });

      const sentMessages = createMessage.mock.calls[0][0]?.messages as
        | Array<{
            role: string;
            content: string;
          }>
        | undefined;
      const userMessage = sentMessages?.[0]?.content;
      expect(userMessage).toContain("transcribe this");
      expect(userMessage).toContain(JSON.stringify(jsonResponse.schema));
    });

    it("retries a transient failure when a caller signal is present but not aborted", async () => {
      // Regression: `retries: signal ? 1 : 3` treated signal presence as an
      // abort and dropped every retry. Only an actually aborted signal is
      // terminal.
      const createMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });

      const controller = new AbortController();

      await runTestCase(createMessage, {
        apiKey: "test-key",
        prompt: "hi",
        signal: controller.signal,
      });

      expect(createMessage).toHaveBeenCalledTimes(2);
    });

    it("does not retry after the caller aborts", async () => {
      const controller = new AbortController();
      controller.abort();

      const createMessage = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );

      await expect(
        runTestCase(createMessage, {
          apiKey: "test-key",
          prompt: "hi",
          signal: controller.signal,
        }),
      ).rejects.toThrow("aborted");

      expect(createMessage).toHaveBeenCalledTimes(1);
    });
  });
}
