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

/**
 * The result a tool call reports when the caller aborts before it answers.
 *
 * A tool call is only ever omitted when it never started; one that started is
 * always paired with a result, or the next provider turn carries an assistant
 * tool call with no matching tool message and the conversation is rejected.
 */
const ABORTED_TOOL_OUTPUT: AgentToolOutput = {
  success: false,
  failureReason: "Tool execution aborted",
};

/**
 * One conversation with a provider: stream a reply, run the tools it asks for,
 * feed the results back, until the model stops asking, the iteration budget runs
 * out, or `abort()` is called.
 *
 * `abort()` means "stop this run". It is scoped to the run rather than to the
 * instance, so the controller and the flag are reset when `run()` starts: a
 * permanently aborted `AbortSignal` handed to a second run is a request that
 * silently does nothing, and the caller sees an empty conversation with no
 * error. Every caller today constructs a loop per request and abandons the
 * aborted one, so this changes nothing for them; it means a loop that *is* reused
 * gets what it looks like it gets.
 */
export class AgentLoop {
  private config: AgentConfig;
  private aborted = false;
  private abortController = new AbortController();
  constructor(config: AgentConfig) {
    this.config = config;
  }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
  }

  async *run(messages: LlmMessage[]): AsyncGenerator<AgentEvent> {
    // A run starts live. An abort left over from a previous run describes that
    // run, and a signal that is already aborted is one the provider and every
    // tool will refuse before doing any work.
    this.aborted = false;
    this.abortController = new AbortController();
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

  /**
   * Run a tool, or give the wait up when the caller aborts.
   *
   * `abort()` sets the flag every other part of the loop reads, but this await
   * was not one of them: a tool that never settles held the generator open, so
   * no `finish` event was ever emitted and whoever was driving the loop waited
   * forever on a stop it had already asked for. The tool's own promise is not
   * cancellable — `AgentToolInput` carries no signal — so racing the abort is
   * what releases the loop. A tool that ignores the cancellation keeps running
   * in the background, which is no worse than before, and the call is still
   * paired with a result so the provider's context stays valid.
   */
  private async executeTool(
    tool: AgentTool,
    toolCallId: string,
    toolParams: Record<string, unknown>,
    reason: unknown,
  ): Promise<AgentToolOutput> {
    if (this.aborted) {
      return ABORTED_TOOL_OUTPUT;
    }
    try {
      // `execute` is typed as returning a promise, but a tool that throws before
      // returning one would escape this frame with no tool-result and no finish
      // event, so the awaited call is inside the same `try` that reports a tool
      // failure. A tool that never settles is released by the race below.
      const run = Promise.resolve(
        tool.execute({
          params: toolParams,
          reason: typeof reason === "string" ? reason : "",
          toolCallId,
        }),
      ).catch((err: unknown) => {
        // A tool must never abort the whole agent loop. Surface the failure
        // as a tool-result message so the model can recover or end cleanly.
        return { success: false, failureReason: unknownToMessage(err) };
      });

      // The abort waiter is per call, not per loop: a shared promise resolves once
      // and its reaction then sits on every result this loop ever produced, which
      // keeps each tool's output alive until the run ends.
      const waitForAbort = (): Promise<AgentToolOutput> =>
        new Promise<AgentToolOutput>((resolve) => {
          if (this.aborted) {
            resolve(ABORTED_TOOL_OUTPUT);
            return;
          }
          this.abortController.signal.addEventListener(
            "abort",
            () => resolve(ABORTED_TOOL_OUTPUT),
            { once: true },
          );
        });

      // Whichever settles first wins; the loser stops mattering because nothing
      // here holds a reference to it once this frame returns.
      return await Promise.race([run, waitForAbort()]);
    } catch (err) {
      return { success: false, failureReason: unknownToMessage(err) };
    }
  }

  private async *processToolCalls(
    history: LlmMessage[],
    toolCalls: LlmToolCall[],
  ): AsyncGenerator<AgentEvent> {
    yield* this.processToolCallsFrom(history, toolCalls, 0);
  }

  /**
   * Walks the tool calls in the order the model emitted them, one at a time.
   *
   * The order is the contract, not an accident of scheduling: every call's
   * result is pushed onto the same history, the provider reads that history
   * back on the next turn, and a consumer pairing a start with its result sees
   * them interleaved in this order. Running two at once would let a tool read
   * state another tool is midway through writing. So the walk recurses from the
   * call after the current one rather than looping over an await.
   *
   * Each step delegates to the next with `yield*`, which keeps a frame per call
   * until the sequence drains. That is bounded well past anything a model emits
   * in one message (the V8 delegation chain holds roughly three thousand), and
   * the whole batch is bounded by the response that produced it.
   */
  private async *processToolCallsFrom(
    history: LlmMessage[],
    toolCalls: LlmToolCall[],
    index: number,
  ): AsyncGenerator<AgentEvent> {
    const tc = toolCalls[index];
    if (!tc) {
      return;
    }

    if (this.aborted) {
      // Once an assistant message emits tool calls, every tool call must be paired
      // with a tool result message in history to keep provider conversational context valid.
      yield this.toolResult(tc, "Tool execution aborted", history, true);
    } else {
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
      } else {
        const { reason, ...toolParams } = params;
        const tool = this.config.tools.find((t) => t.name === tc.name);

        if (!tool) {
          yield this.toolResult(tc, `Unknown tool: ${tc.name}`, history, true);
        } else {
          const output = await this.executeTool(
            tool,
            tc.id,
            toolParams,
            reason,
          );
          const resultStr = output.success
            ? stringifyToolResult(output.result)
            : (output.failureReason ?? "Tool execution failed");

          yield this.toolResult(tc, resultStr, history, !output.success);
        }
      }
    }

    yield* this.processToolCallsFrom(history, toolCalls, index + 1);
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
