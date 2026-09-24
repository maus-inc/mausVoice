import type {
  JSONSchema,
  LlmChatInput,
  LlmMessage,
  LlmToolCall,
} from "@maus-inc/types";
import type {
  AgentConfig,
  AgentEvent,
  AgentFinishReason,
  AgentTool,
  AgentToolOutput,
} from "./types";
import { parseJsonObject, unknownToMessage } from "@maus-inc/utilities";

/** Render a tool's successful result to a string. */
const stringifyToolResult = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result ?? {});

export class AgentLoop {
  private config: AgentConfig;
  private aborted = false;
  private readonly abortController = new AbortController();

  constructor(config: AgentConfig) {
    this.config = config;
  }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
  }

  async *run(messages: LlmMessage[]): AsyncGenerator<AgentEvent> {
    const history: LlmMessage[] = [...messages];
    const maxIterations = this.config.maxIterations ?? 30;

    for (let i = 0; i < maxIterations; i++) {
      if (this.aborted) {
        yield this.finishEvent(history, "aborted");
        return;
      }
      yield { type: "iteration-start", iteration: i };
      const turn = yield* this.streamTurn(history);
      if (!turn) return;

      const { content, toolCalls } = turn;
      history.push({
        role: "assistant",
        content: content || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      if (toolCalls.length === 0) {
        yield this.finishEvent(history, "stop", content);
        return;
      }
      yield* this.processToolCalls(history, toolCalls);
    }
    yield this.finishEvent(
      history,
      this.aborted ? "aborted" : "max-iterations",
    );
  }

  private finishEvent(
    history: LlmMessage[],
    reason: AgentFinishReason,
    text = "",
    error?: string,
  ): AgentEvent {
    return {
      type: "finish",
      reason,
      text,
      messages: history,
      ...(error === undefined ? {} : { error }),
    };
  }

  private async *streamTurn(
    history: LlmMessage[],
  ): AsyncGenerator<
    AgentEvent,
    { content: string; toolCalls: LlmToolCall[] } | null
  > {
    let content = "";
    const toolCalls: LlmToolCall[] = [];
    try {
      for await (const event of this.config.provider.streamChat(
        this.buildInput(history),
      )) {
        if (this.aborted) break;
        switch (event.type) {
          case "text-delta":
            content += event.text;
            yield { type: "text-delta", text: event.text };
            break;
          case "tool-call":
            toolCalls.push({
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            });
            break;
          case "error":
            yield this.finishEvent(history, "error", "", event.error);
            return null;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield this.finishEvent(
        history,
        this.aborted ? "aborted" : "error",
        "",
        this.aborted ? undefined : message,
      );
      return null;
    }
    if (this.aborted) {
      yield this.finishEvent(history, "aborted");
      return null;
    }
    return { content, toolCalls };
  }

  private buildInput(history: LlmMessage[]): LlmChatInput {
    return {
      signal: this.abortController.signal,
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
    toolCallId: string,
    toolParams: Record<string, unknown>,
    reason: unknown,
  ): Promise<AgentToolOutput> {
    try {
      return await tool.execute({
        params: toolParams,
        reason: typeof reason === "string" ? reason : "",
        toolCallId,
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
      if (this.aborted) {
        // Once an assistant message emits tool calls, every tool call must be paired
        // with a tool result message in history to keep provider conversational context valid.
        yield this.toolResult(tc, "Tool execution aborted", history, true);
        continue;
      }

      const params = parseJsonObject(tc.arguments);

      yield {
        type: "tool-call-start",
        toolCallId: tc.id,
        toolName: tc.name,
        args: params ?? {},
      };

      // Once tool-call-start is emitted, always pair it with a tool-call-result
      // (and history entry) even if abort wins mid-flight. Skipping the result
      // leaves the assistant tool-call without a matching tool message.
      if (!params) {
        yield this.toolResult(
          tc,
          "Tool arguments must be a JSON object",
          history,
          true,
        );
        continue;
      }
      const { reason, ...toolParams } = params;
      const tool = this.config.tools.find((t) => t.name === tc.name);

      if (!tool) {
        yield this.toolResult(tc, `Unknown tool: ${tc.name}`, history, true);
        continue;
      }

      const output = await this.executeTool(tool, tc.id, toolParams, reason);
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
