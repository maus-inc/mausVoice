import type {
  JSONSchema,
  LlmChatInput,
  LlmMessage,
  LlmToolCall,
} from "@maus-inc/types";
import type { AgentConfig, AgentEvent } from "./types";

export class AgentLoop {
  private readonly config: AgentConfig;
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

      const status = yield* this.runIteration(history, i);
      if (status === "stop") {
        return;
      }
    }

    yield {
      type: "finish",
      reason: "max-iterations",
      text: "",
      messages: history,
    };
  }

  private async *runIteration(
    history: LlmMessage[],
    iteration: number,
  ): AsyncGenerator<AgentEvent, "continue" | "stop"> {
    yield { type: "iteration-start", iteration };
    if (this.aborted) {
      return "stop";
    }

    const result = yield* this.consumeStream(history, this.buildInput(history));
    if (result.error) {
      yield {
        type: "finish",
        reason: "error",
        text: "",
        messages: history,
        error: result.error,
      };
      return "stop";
    }

    if (this.aborted) {
      yield {
        type: "finish",
        reason: "aborted",
        text: "",
        messages: history,
      };
      return "stop";
    }

    history.push({
      role: "assistant",
      content: result.content || undefined,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    });

    if (result.toolCalls.length === 0) {
      yield {
        type: "finish",
        reason: "stop",
        text: result.content,
        messages: history,
      };
      return "stop";
    }

    yield* this.processToolCalls(history, result.toolCalls);
    return "continue";
  }

  private async *consumeStream(
    history: LlmMessage[],
    input: LlmChatInput,
  ): AsyncGenerator<
    AgentEvent,
    { content: string; toolCalls: LlmToolCall[]; error?: string }
  > {
    let content = "";
    const toolCalls: LlmToolCall[] = [];

    try {
      for await (const event of this.config.provider.streamChat(input)) {
        if (this.aborted) {
          return { content, toolCalls };
        }

        if (event.type === "text-delta") {
          content += event.text;
          yield { type: "text-delta", text: event.text };
        } else if (event.type === "tool-call") {
          toolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          });
        } else if (event.type === "error") {
          return { content, toolCalls, error: event.error };
        }
      }
    } catch (err) {
      return {
        content,
        toolCalls,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { content, toolCalls };
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

      const { reason, ...toolParams } = params;
      const tool = this.config.tools.find((t) => t.name === tc.name);

      if (!tool) {
        const error = `Unknown tool: ${tc.name}`;
        history.push({ role: "tool", toolCallId: tc.id, content: error });
        yield {
          type: "tool-call-result",
          toolCallId: tc.id,
          toolName: tc.name,
          result: error,
          isError: true,
        };
        continue;
      }

      const output = await tool.execute({
        params: toolParams,
        reason: (reason as string) ?? "",
      });

      let resultStr: string;
      if (!output.success) {
        resultStr = output.failureReason ?? "Tool execution failed";
      } else if (typeof output.result === "string") {
        resultStr = output.result;
      } else {
        resultStr = JSON.stringify(output.result ?? {});
      }

      history.push({ role: "tool", toolCallId: tc.id, content: resultStr });
      yield {
        type: "tool-call-result",
        toolCallId: tc.id,
        toolName: tc.name,
        result: resultStr,
        isError: !output.success,
      };
    }
  }
}
