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

    const events = (await collectEvents(
      loop.run([{ role: "user", content: "go" }]),
    )) as Array<{ type: string; [k: string]: unknown }>;

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

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ reason: "stop", text: "Done." });
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
    const events = (await collectEvents(
      loop.run([{ role: "user", content: "go" }]),
    )) as Array<Record<string, unknown>>;
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ reason: "error", error: "network down" });
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

  it("aborts mid-loop and reports the aborted reason", async () => {
    let resolveAbort: () => void = () => {};
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

  it("renders a plain text answer without tools as a single stop", async () => {
    const loop = new AgentLoop({
      provider: textProvider(["Hello", " there"]),
      tools: [echoTool()],
      systemPrompt: "sys",
    });
    const events = (await collectEvents(
      loop.run([{ role: "user", content: "hi" }]),
    )) as Array<Record<string, unknown>>;
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);
    expect(events.find((e) => e.type === "finish")).toMatchObject({
      reason: "stop",
      text: "Hello there",
    });
  });
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
    const { provider } = scriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_4",
          name: "rejecter",
          arguments: JSON.stringify({ reason: "x" }),
        },
      ],
      [{ type: "text-delta", text: "done" }],
    ]);
    const loop = new AgentLoop({ provider, tools: [throwing], systemPrompt: "sys" });
    const events = (await collectEvents(
      loop.run([{ role: "user", content: "go" }]),
    )) as Array<{ type: string; result?: string }>;
    const toolResult = events.find((e) => e.type === "tool-call-result");
    // JSON representation of the object, never "[object Object]" or undefined.
    expect(toolResult?.result).toBe(JSON.stringify({ code: "E_BOOM", detail: "secret" }));
  });
