import type {
  JSONSchema,
  LlmChatInput,
  LlmMessage,
  LlmToolCall,
} from "@maus-inc/types";
import type {
  AgentConfig,
  AgentEvent,
  AgentTool,
  AgentToolOutput,
} from "./types";

/** Render a tool's successful result to a string. */
const stringifyToolResult = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result ?? {});

/** Coerce an unknown thrown value into a readable string without producing
 * `[object Object]` for a plain object. */
const safeStringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export class AgentLoop {
  private config: AgentConfig;
  private aborted = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  abort(): void {
    this.aborted = true;
  }

  async *run(messages: LlmMessage[]): AsyncGenerator<AgentEvent> {
    const history: LlmMessage[] = [...messages];
    const maxIterations = this.config.maxIterations ?? 30;

    for (let i = 0; i < maxIterations; i++) {
      if (this.aborted) {
        yield {
          type: "finish",
          reason: "aborted",
          text: "",
          messages: history,
        };
        return;
      }

      yield { type: "iteration-start", iteration: i };

      const input = this.buildInput(history);
      let content = "";
      const toolCalls: LlmToolCall[] = [];

      try {
        for await (const event of this.config.provider.streamChat(input)) {
          if (this.aborted) break;

          if (event.type === "text-delta") {
            content += event.text;
            yield { type: "text-delta", text: event.text };
          }

          if (event.type === "tool-call") {
            toolCalls.push({
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            });
          }

          if (event.type === "error") {
            yield {
              type: "finish",
              reason: "error",
              text: "",
              messages: history,
              error: event.error,
            };
            return;
          }
        }
      } catch (err) {
        yield {
          type: "finish",
          reason: "error",
          text: "",
          messages: history,
          error: err instanceof Error ? err.message : String(err),
        };
        return;
      }

      if (this.aborted) {
        yield {
          type: "finish",
          reason: "aborted",
          text: "",
          messages: history,
        };
        return;
      }

      history.push({
        role: "assistant",
        content: content || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) {
        yield {
          type: "finish",
          reason: "stop",
          text: content,
          messages: history,
        };
        return;
      }

      yield* this.processToolCalls(history, toolCalls);
    }

    yield {
      type: "finish",
      reason: "max-iterations",
      text: "",
      messages: history,
    };
  }

  private buildInput(history: LlmMessage[]): LlmChatInput {
    return {
      messages: [
        { role: "system", content: this.config.systemPrompt },
        ...history,
      ],
      ...(this.config.tools.length > 0 && {
        tools: this.config.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: this.withReason(t.parameters),
        })),
        toolChoice: "auto" as const,
      }),
    };
  }

  private withReason(parameters: JSONSchema): JSONSchema {
    const schema = { ...parameters } as Record<string, unknown>;
    const properties = {
      ...(schema.properties as Record<string, unknown> | undefined),
      reason: {
        type: "string" as const,
        description: "Why you are calling this tool",
      },
    };
    const required = [...((schema.required as string[]) ?? []), "reason"];
    return { ...schema, properties, required };
  }

  private async executeTool(
    tool: AgentTool,
    toolParams: Record<string, unknown>,
    reason: unknown,
  ): Promise<AgentToolOutput> {
    try {
      return await tool.execute({
        params: toolParams,
        reason: (reason as string) ?? "",
      });
    } catch (err) {
      // A tool must never abort the whole agent loop. Surface the failure
      // as a tool-result message so the model can recover or end cleanly.
      return {
        success: false,
        failureReason: err instanceof Error ? err.message : safeStringify(err),
      };
    }
  }

  private async *processToolCalls(
    history: LlmMessage[],
    toolCalls: LlmToolCall[],
  ): AsyncGenerator<AgentEvent> {
    for (const tc of toolCalls) {
      if (this.aborted) return;

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(tc.arguments);
      } catch {
        params = {};
      }

      yield {
        type: "tool-call-start",
        toolCallId: tc.id,
        toolName: tc.name,
        args: params,
      };

      if (this.aborted) return;

      const { reason, ...toolParams } = params;
      const tool = this.config.tools.find((t) => t.name === tc.name);

      if (!tool) {
        yield this.toolResult(tc, `Unknown tool: ${tc.name}`, history, true);
        continue;
      }

      const output = await this.executeTool(tool, toolParams, reason);
      if (this.aborted) return;

      const resultStr = output.success
        ? stringifyToolResult(output.result)
        : (output.failureReason ?? "Tool execution failed");

      yield this.toolResult(tc, resultStr, history, !output.success);
    }
  }

  private toolResult(
    tc: LlmToolCall,
    result: string,
    history: LlmMessage[],
    isError: boolean,
  ): AgentEvent {
    history.push({ role: "tool", toolCallId: tc.id, content: result });
    return {
      type: "tool-call-result",
      toolCallId: tc.id,
      toolName: tc.name,
      result,
      isError,
    };
  }
}
