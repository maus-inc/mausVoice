import { describe, expect, it, vi } from "vitest";
import type { LlmChatInput, LlmMessage, LlmStreamEvent } from "@maus-inc/types";
import { AgentLoop } from "./agent-loop";
import type { AgentLlmProvider, AgentTool } from "./types";

function collectEvents(events: AsyncGenerator<unknown>) {
  return (async () => {
    const out: unknown[] = [];
    for await (const e of events) out.push(e);
    return out;
  })();
}

function textProvider(chunks: string[]): AgentLlmProvider {
  return {
    async *streamChat(): AsyncGenerator<LlmStreamEvent> {
      for (const chunk of chunks) {
        yield { type: "text-delta", text: chunk };
      }
    },
  };
}

function scriptedProvider(
  scripts: Array<AsyncGenerator<LlmStreamEvent> | LlmStreamEvent[]>,
): { provider: AgentLlmProvider; calls: LlmChatInput[] } {
  const calls: LlmChatInput[] = [];
  let i = 0;
  const provider: AgentLlmProvider = {
    async *streamChat(input) {
      calls.push(input);
      const script = scripts[i++];
      if (!script) return;
      if (Array.isArray(script)) {
        for (const e of script) yield e;
      } else {
        for await (const e of script) yield e;
      }
    },
  };
  return { provider, calls };
}

function echoTool(name = "echo"): AgentTool {
  return {
    name,
    description: "echoes input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async ({ params }) => ({
      success: true,
      result: `echo:${String(params.text ?? "")}`,
    }),
  };
}

function toolCallEvent(id: string, name: string): LlmStreamEvent {
  return {
    type: "tool-call",
    id,
    name,
    arguments: JSON.stringify({ reason: "x" }),
  };
}

function expectErrorContinuation(params: {
  tool: AgentTool;
  callId: string;
  errorFragment: string;
  finalText: string;
}) {
  const { provider } = scriptedProvider([
    [toolCallEvent(params.callId, params.tool.name)],
    [{ type: "text-delta", text: params.finalText }],
  ]);
  const loop = new AgentLoop({
    provider,
    tools: [params.tool],
    systemPrompt: "sys",
  });
  return expectErrorEvents(loop, params.errorFragment, params.finalText);
}

async function expectErrorEvents(
  loop: AgentLoop,
  errorFragment: string,
  finalText: string,
) {
  const events = (await collectEvents(
    loop.run([{ role: "user", content: "go" }]),
  )) as Array<{ type: string; isError?: boolean; result?: string }>;
  const toolResult = events.find((e) => e.type === "tool-call-result");
  expect(toolResult?.isError).toBe(true);
  expect(toolResult?.result).toContain(errorFragment);
  const finish = events.find((e) => e.type === "finish");
  expect(finish).toMatchObject({ reason: "stop", text: finalText });
}

async function runLoop(loop: AgentLoop) {
  return (await collectEvents(
    loop.run([{ role: "user", content: "go" }]),
  )) as Array<Record<string, unknown>>;
}

function expectFinish(
  events: Array<Record<string, unknown>>,
  expected: Record<string, unknown>,
) {
  const finish = events.find((e) => e.type === "finish");
  expect(finish).toMatchObject(expected);
}

describe("AgentLoop", () => {
  it("continues after a tool result and produces a final response without a second prompt", async () => {
    // First model turn requests one tool; second turn returns the final text.
    const { provider, calls } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_1",
          name: "echo",
          arguments: JSON.stringify({ reason: "test", text: "hi" }),
        },
      ],
      [{ type: "text-delta", text: "Done." }],
    ]);

    const loop = new AgentLoop({
      provider,
      tools: [echoTool()],
      systemPrompt: "sys",
      maxIterations: 5,
    });

    const events = await runLoop(loop);

    // Two provider calls: the tool-request turn and the post-tool turn.
    expect(calls).toHaveLength(2);

    // The second call must contain the assistant tool-call message followed
    // by the matching tool result, so the model can continue.
    const secondHistory = calls[1].messages;
    const assistantMsg = secondHistory.find(
      (m) => m.role === "assistant",
    ) as Extract<LlmMessage, { role: "assistant" }>;
    expect(assistantMsg?.toolCalls?.[0]?.id).toBe("call_1");
    expect(secondHistory.some((m) => m.role === "tool")).toBe(true);

    expectFinish(events, { reason: "stop", text: "Done." });
  });

  it("turns a failed tool execution into an error tool-result and continues", async () => {
    const failing: AgentTool = {
      name: "boom",
      description: "always fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        success: false,
        failureReason: "kaboom",
      })),
    };
    await expectErrorContinuation({
      tool: failing,
      callId: "call_2",
      errorFragment: "kaboom",
      finalText: "Recovered.",
    });
  });

  it("catches a tool that throws and still continues the loop", async () => {
    const throwing: AgentTool = {
      name: "boom",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    };
    await expectErrorContinuation({
      tool: throwing,
      callId: "call_3",
      errorFragment: "kaboom",
      finalText: "Handled.",
    });
  });

  it("reports a terminal error when the provider stream fails", async () => {
    const errorProvider: AgentLlmProvider = {
      async *streamChat() {
        throw new Error("network down");
      },
    };
    const loop = new AgentLoop({
      provider: errorProvider,
      tools: [],
      systemPrompt: "sys",
    });
    const events = await runLoop(loop);
    expectFinish(events, { reason: "error", error: "network down" });
  });

  it("stops at maxIterations with a visible terminal reason", async () => {
    // Every turn requests the tool; the loop must not silently stop, it
    // emits a `max-iterations` finish.
    const alwaysTool = (): AgentLlmProvider => ({
      async *streamChat() {
        yield {
          type: "tool-call",
          id: "c",
          name: "echo",
          arguments: JSON.stringify({ reason: "r", text: "x" }),
        };
      },
    });
    const loop = new AgentLoop({
      provider: alwaysTool(),
      tools: [echoTool()],
      systemPrompt: "sys",
      maxIterations: 2,
    });
    const events = (await collectEvents(
      loop.run([{ role: "user", content: "go" }]),
    )) as Array<Record<string, unknown>>;
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.reason).toBe("max-iterations");
    // Exactly two tool calls were executed.
    expect(events.filter((e) => e.type === "tool-call-result")).toHaveLength(2);
  });

  it.each(["null", "[]", "42", '"text"', "true", "invalid JSON"])(
    "reports invalid tool arguments %s without executing and continues",
    async (argumentsJson) => {
      const execute = vi
        .fn()
        .mockResolvedValue({ success: true, result: "unsafe dispatch" });
      const tool: AgentTool = {
        name: "guarded",
        description: "test",
        parameters: {},
        execute,
      };
      const { provider } = scriptedProvider([
        [
          {
            type: "tool-call",
            id: "invalid-call",
            name: "guarded",
            arguments: argumentsJson,
          },
        ],
        [{ type: "text-delta", text: "Recovered" }],
      ]);
      const loop = new AgentLoop({
        provider,
        tools: [tool],
        systemPrompt: "s",
      });
      const events = await collectEvents(
        loop.run([{ role: "user", content: "go" }]),
      );
      expect(execute).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool-call-result",
          toolCallId: "invalid-call",
          isError: true,
        }),
      );
      expect(events[events.length - 1]).toMatchObject({
        type: "finish",
        reason: "stop",
        text: "Recovered",
      });
    },
  );

  it("starts a later run live after an earlier one was aborted", async () => {
    // `abort()` is scoped to the run it interrupts. Left permanent, the second
    // run inherited an already-aborted `AbortSignal` and the `aborted` flag, so
    // every provider turn and every tool was refused before doing any work --
    // and the caller saw an empty conversation rather than an error, because
    // nothing had failed. A loop that is reused has to work.
    const seen: AbortSignal[] = [];
    const provider: AgentLlmProvider = {
      async *streamChat(input) {
        seen.push(input.signal as AbortSignal);
        yield { type: "text-delta", text: "hello" };
      },
    };
    const loop = new AgentLoop({
      provider,
      tools: [],
      systemPrompt: "s",
    });

    loop.abort();
    const events = [];
    for await (const event of loop.run([{ role: "user", content: "go" }])) {
      events.push(event);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "finish", reason: "stop" }),
    );
  });

  it("aborts mid-loop and reports the aborted reason", async () => {
    let resolveAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const slow: AgentLlmProvider = {
      async *streamChat() {
        yield { type: "text-delta", text: "partial" };
        // Wait until abort is signalled, then yield once more so the loop's
        // `if (this.aborted) break` check runs on the next iteration instead
        // of hanging the generator forever.
        await abortGate;
        yield { type: "text-delta", text: " after abort" };
      },
    };
    const loop = new AgentLoop({
      provider: slow,
      tools: [],
      systemPrompt: "s",
    });
    const gen = loop.run([{ role: "user", content: "go" }]);
    // The first event is always iteration-start; advance to the streaming
    // text-delta before aborting.
    await gen.next();
    const streamed = await gen.next();
    expect(streamed.value).toMatchObject({ type: "text-delta" });
    loop.abort();
    resolveAbort();
    const next = await gen.next();
    expect(next.value).toMatchObject({ type: "finish", reason: "aborted" });
  });

  it("aborts a blocked provider request without waiting for another chunk", async () => {
    const capture = vi.fn<(input: LlmChatInput) => void>();
    let release = () => {};
    const provider: AgentLlmProvider = {
      async *streamChat(input) {
        capture(input);
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        });
        yield {
          type: "text-delta",
          text: "must not arrive after cancellation",
        };
      },
    };
    const loop = new AgentLoop({ provider, tools: [], systemPrompt: "s" });
    const pending = collectEvents(loop.run([{ role: "user", content: "go" }]));
    try {
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
      const signal = capture.mock.calls[0][0].signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      loop.abort();
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual([
        { type: "iteration-start", iteration: 0 },
        expect.objectContaining({ type: "finish", reason: "aborted" }),
      ]);
    } finally {
      release();
      await pending;
    }
  });

  it.each([1, 3])(
    "pairs tool-call results on abort with a %i-iteration limit",
    async (maxIterations) => {
      let resolveTool!: (value: { success: true; result: string }) => void;
      const toolGate = new Promise<{ success: true; result: string }>(
        (resolve) => {
          resolveTool = resolve;
        },
      );
      const slowTool: AgentTool = {
        name: "slow",
        description: "resolves after abort is signalled",
        parameters: { type: "object", properties: {} },
        execute: () => toolGate,
      };
      const { provider } = scriptedProvider([
        [
          {
            type: "tool-call",
            id: "call_abort",
            name: "slow",
            arguments: JSON.stringify({ reason: "r" }),
          },
        ],
      ]);
      const loop = new AgentLoop({
        provider,
        tools: [slowTool],
        systemPrompt: "sys",
        maxIterations,
      });
      const gen = loop.run([{ role: "user", content: "go" }]);

      // Drain through iteration-start and tool-call-start, then abort while the
      // tool is still pending. The start event must still get a matching result.
      expect((await gen.next()).value).toMatchObject({
        type: "iteration-start",
      });
      expect((await gen.next()).value).toMatchObject({
        type: "tool-call-start",
        toolCallId: "call_abort",
      });
      loop.abort();
      resolveTool({ success: true, result: "done-after-abort" });

      // The pairing is the invariant this test exists for, and it is unchanged.
      // Which result fills the pair is not: the abort now ends the wait, so a
      // tool that had not answered by then reports as cancelled rather than as a
      // result the loop kept waiting for. The sibling test below covers the tool
      // that settles first, which still carries its own result.
      const resultEvent = await gen.next();
      expect(resultEvent.value).toMatchObject({
        type: "tool-call-result",
        toolCallId: "call_abort",
        result: "Tool execution aborted",
        isError: true,
      });

      const finish = await gen.next();
      expect(finish.value).toMatchObject({ type: "finish", reason: "aborted" });
      const finishMessages = (
        finish.value as { messages?: Array<{ role: string; content?: string }> }
      ).messages;
      expect(
        finishMessages?.some(
          (m) => m.role === "tool" && m.content === "Tool execution aborted",
        ),
      ).toBe(true);
    },
  );

  // `abort()` sets the flag the rest of the loop reads, but the tool call was
  // awaited without consulting it, and the SDK's one-shot callback API has no
  // signal to hand the tool. A tool that never settles therefore held the
  // generator open with no `finish` event ever emitted, so the caller waited
  // forever on a stop it had already asked for.
  it("stops waiting on a tool that never settles once the caller aborts", async () => {
    const hanging: AgentTool = {
      name: "hangs",
      description: "never settles",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(
        () => new Promise<{ success: true; result: string }>(() => {}),
      ),
    } as unknown as AgentTool;
    const { provider } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_hang",
          name: "hangs",
          arguments: JSON.stringify({ reason: "r" }),
        },
      ],
    ]);
    const loop = new AgentLoop({
      provider,
      tools: [hanging],
      systemPrompt: "sys",
      maxIterations: 2,
    });
    const gen = loop.run([{ role: "user", content: "go" }]);

    expect((await gen.next()).value).toMatchObject({
      type: "iteration-start",
    });
    // Resume without awaiting: this step yields `tool-call-start` and the next
    // `next()` is the one that suspends inside `await this.executeTool(...)`.
    // Aborting before that point only sets the flag the guard already reads, so
    // the tool is never awaited and the race below is not exercised at all.
    expect((await gen.next()).value).toMatchObject({
      type: "tool-call-start",
      toolCallId: "call_hang",
    });
    const suspended = gen.next();
    await vi.waitFor(() => {
      expect(hanging.execute).toHaveBeenCalled();
    });
    loop.abort();

    // The generator has to resume on its own, with nothing but the abort to
    // release it.
    const result = await suspended;
    expect(result.value).toMatchObject({
      type: "tool-call-result",
      toolCallId: "call_hang",
      isError: true,
    });
    const finish = await gen.next();
    expect(finish.value).toMatchObject({ type: "finish", reason: "aborted" });
    // The tool call is still paired in the history the provider would read
    // back, so the context stays valid.
    const messages = (finish.value as { messages?: LlmMessage[] }).messages;
    expect(
      messages?.some((m) => m.role === "tool" && m.toolCallId === "call_hang"),
    ).toBe(true);
  });

  it("keeps waiting on a tool that settles before the abort", async () => {
    // The abort must not turn a slow tool into a failure: a result that arrived
    // before it fired is the model's answer, not a cancelled call.
    let release = () => {};
    const gate = new Promise<{ success: true; result: string }>((resolve) => {
      release = () => resolve({ success: true, result: "done" });
    });
    const slowTool: AgentTool = {
      name: "slow",
      description: "resolves on demand",
      parameters: { type: "object", properties: {} },
      execute: () => gate,
    };
    const { provider } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_slow",
          name: "slow",
          arguments: JSON.stringify({ reason: "r" }),
        },
      ],
    ]);
    const loop = new AgentLoop({
      provider,
      tools: [slowTool],
      systemPrompt: "sys",
      maxIterations: 2,
    });
    const gen = loop.run([{ role: "user", content: "go" }]);
    await gen.next();
    await gen.next();
    // Suspend inside the tool, let it answer, then abort: the result is already
    // in hand, so it is the model's answer and not a cancelled call. Aborting
    // without ever entering the tool would leave this a plain execution test.
    const suspended = gen.next();
    release();
    const result = await suspended;
    expect(result.value).toMatchObject({
      type: "tool-call-result",
      toolCallId: "call_slow",
      result: "done",
      isError: false,
    });
    loop.abort();
  });

  it("runs one tool call at a time and keeps the model's order", async () => {
    // A single assistant message can carry several tool calls. Each one has to
    // run on its own and in the order the model wrote them: the results share
    // one history that the provider reads back, and a tool that is halfway
    // through writing state must finish before the next one reads it.
    const trace: string[] = [];
    const ordered: AgentTool = {
      name: "ordered",
      description: "records when it starts and finishes",
      parameters: { type: "object", properties: {} },
      execute: async ({ params }) => {
        const tag = String(params.tag ?? "");
        trace.push(`enter:${tag}`);
        await Promise.resolve();
        trace.push(`exit:${tag}`);
        return { success: true, result: tag };
      },
    };
    const { provider, calls } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_a",
          name: "ordered",
          arguments: '{"reason":"r","tag":"a"}',
        },
        {
          type: "tool-call",
          id: "call_b",
          name: "nope",
          arguments: '{"reason":"r"}',
        },
        {
          type: "tool-call",
          id: "call_c",
          name: "ordered",
          arguments: "not json",
        },
        {
          type: "tool-call",
          id: "call_d",
          name: "ordered",
          arguments: '{"reason":"r","tag":"d"}',
        },
      ],
      [{ type: "text-delta", text: "Finished." }],
    ]);
    const loop = new AgentLoop({
      provider,
      tools: [ordered],
      systemPrompt: "sys",
      maxIterations: 3,
    });

    const events = await runLoop(loop);

    // Never two tools in flight at once.
    expect(trace).toEqual(["enter:a", "exit:a", "enter:d", "exit:d"]);

    // Every call is paired with a result, in the model's order, and the two
    // that could not run still report why.
    const flow = events
      .filter(
        (e) => e.type === "tool-call-start" || e.type === "tool-call-result",
      )
      .map((e) => `${e.type}:${e.toolCallId}${e.isError ? ":error" : ""}`);
    expect(flow).toEqual([
      "tool-call-start:call_a",
      "tool-call-result:call_a",
      "tool-call-start:call_b",
      "tool-call-result:call_b:error",
      "tool-call-start:call_c",
      "tool-call-result:call_c:error",
      "tool-call-start:call_d",
      "tool-call-result:call_d",
    ]);

    // The history the provider reads back keeps the same order.
    const toolMessages = calls[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toMatchObject([
      { toolCallId: "call_a", content: "a" },
      { toolCallId: "call_b" },
      { toolCallId: "call_c" },
      { toolCallId: "call_d", content: "d" },
    ]);
  });

  it("handles a large batch of tool calls from one message", async () => {
    // The walk delegates to the next call with `yield*`, which holds a frame per
    // call until the batch drains. A model can emit a long list, so the walk has
    // to stay inside the engine's delegation depth rather than assuming a
    // handful. 400 is far more than any provider emits in one message.
    const count = 400;
    const { provider } = scriptedProvider([
      [
        ...Array.from({ length: count }, (_unused, index) => ({
          type: "tool-call" as const,
          id: `bulk_${index}`,
          name: "echo",
          arguments: JSON.stringify({ reason: "r" }),
        })),
      ],
      [{ type: "text-delta", text: "done" }],
    ]);
    const loop = new AgentLoop({
      provider,
      tools: [echoTool()],
      systemPrompt: "sys",
      maxIterations: 3,
    });

    const events = await runLoop(loop);
    const results = events.filter((e) => e.type === "tool-call-result");
    expect(results).toHaveLength(count);
    expect(results[0]).toMatchObject({ toolCallId: "bulk_0" });
    expect(results[count - 1]).toMatchObject({
      toolCallId: `bulk_${count - 1}`,
    });
    expectFinish(events, { reason: "stop", text: "done" });
  });

  it("renders a plain text answer without tools as a single stop", async () => {
    const loop = new AgentLoop({
      provider: textProvider(["Hello", " there"]),
      tools: [echoTool()],
      systemPrompt: "sys",
    });
    const events = await runLoop(loop);
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);
    expectFinish(events, { reason: "stop", text: "Hello there" });
  });

  it("stringifies a non-Error thrown value instead of [object Object]", async () => {
    const throwing: AgentTool = {
      name: "rejecter",
      description: "rejects with a plain object",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { code: "E_BOOM", detail: "secret" };
      }),
    };
    await expectErrorContinuation({
      tool: throwing,
      callId: "call_4",
      errorFragment: JSON.stringify({ code: "E_BOOM", detail: "secret" }),
      finalText: "done",
    });
  });

  it("keeps the run alive when a tool throws before returning a promise", async () => {
    // `execute` is typed as returning a promise. A tool that throws before
    // returning one escapes that contract, and the throw used to propagate out
    // of `executeTool`: the run rejected with no tool-result and no finish event,
    // so the caller waited forever on a call the loop had already failed.
    const thrower: AgentTool = {
      name: "boom",
      description: "throws before returning",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("threw before returning");
      },
    } as AgentTool;
    const { provider } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_boom",
          name: "boom",
          arguments: JSON.stringify({ reason: "r" }),
        },
      ],
    ]);
    const loop = new AgentLoop({
      provider,
      tools: [thrower],
      systemPrompt: "sys",
      maxIterations: 2,
    });
    const gen = loop.run([{ role: "user", content: "go" }]);
    const seen: unknown[] = [];
    for (let step = 0; step < 6; step += 1) {
      const next = await gen.next();
      if (next.done) break;
      seen.push((next.value as { type: string }).type);
      if ((next.value as { type: string }).type === "finish") break;
    }
    expect(seen).toContain("tool-call-result");
    expect(seen).toContain("finish");
  });
});
