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
import { unknownToMessage } from "@maus-inc/utilities";

/** Render a tool's successful result to a string. */
const stringifyToolResult = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result ?? {});

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
        failureReason: unknownToMessage(err),
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

      // Once tool-call-start is emitted, always pair it with a tool-call-result
      // (and history entry) even if abort wins mid-flight. Skipping the result
      // leaves the assistant tool-call without a matching tool message.
      const { reason, ...toolParams } = params;
      const tool = this.config.tools.find((t) => t.name === tc.name);

      if (!tool) {
        yield this.toolResult(tc, `Unknown tool: ${tc.name}`, history, true);
        if (this.aborted) return;
        continue;
      }

      const output = await this.executeTool(tool, toolParams, reason);
      const resultStr = output.success
        ? stringifyToolResult(output.result)
        : (output.failureReason ?? "Tool execution failed");

      yield this.toolResult(tc, resultStr, history, !output.success);

      if (this.aborted) return;
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
