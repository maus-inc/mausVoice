import { afterEach, describe, expect, it, vi } from "vitest";

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
    afterEach(() => {
      vi.doUnmock("@anthropic-ai/sdk");
      vi.resetModules();
    });

    const buildCreateMessage = (text = "ok") =>
      vi.fn().mockResolvedValue({
        content: [{ type: "text", text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
      const createMessage = buildCreateMessage();

      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = {
            create: createMessage,
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName];

      await fn({
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

      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = {
            create: createMessage,
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName];

      await fn({
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

      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = {
            create: createMessage,
          };
        },
      }));

      const mod = await loadModule();
      const fn = mod[functionName];

      const jsonResponse = {
        name: "schema",
        description: "x",
        schema: {
          type: "object" as const,
          properties: { result: { type: "string" as const } },
          required: ["result"],
        },
      };

      await fn({
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
  });
}
