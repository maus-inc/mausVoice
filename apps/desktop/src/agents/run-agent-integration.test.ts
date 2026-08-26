import { describe, expect, it, vi } from "vitest";

const {
  loopRunMock,
  getAgentRepoMock,
  getChatMessageRepoMock,
  getAppStateMock,
  produceAppStateMock,
  createAgentRunStateMock,
  createAgentToolsMock,
  humanizeScrubMock,
  modifyAgentStateMock,
  getChatMessageRepoCreateMock,
  agentLoopRun,
  loggerMock,
} = vi.hoisted(() => {
  const loopRunMock = vi.fn();
  const getAgentRepoMock = vi.fn();
  const getChatMessageRepoMock = vi.fn();
  const getAppStateMock = vi.fn();
  const produceAppStateMock = vi.fn();
  const createAgentRunStateMock = vi.fn();
  const createAgentToolsMock = vi.fn();
  const humanizeScrubMock = vi.fn();
  const modifyAgentStateMock = vi.fn();
  const getChatMessageRepoCreateMock = vi.fn();
  const agentLoopRun = (events: unknown[]) => {
    async function* gen() {
      for (const event of events) yield event;
    }
    return gen();
  };
  const loggerMock = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  };
  return {
    loopRunMock,
    getAgentRepoMock,
    getChatMessageRepoMock,
    getAppStateMock,
    produceAppStateMock,
    createAgentRunStateMock,
    createAgentToolsMock,
    humanizeScrubMock,
    modifyAgentStateMock,
    getChatMessageRepoCreateMock,
    agentLoopRun,
    loggerMock,
  };
});

vi.mock("@repo/agent", () => {
  class AgentLoop {
    constructor(_args: unknown) {}
    abort() {}
    run(...args: unknown[]) {
      return loopRunMock(...args);
    }
  }
  return { AgentLoop };
});

vi.mock("../repos", () => ({
  getAgentRepo: () => getAgentRepoMock(),
  getChatMessageRepo: () => getChatMessageRepoMock(),
}));

vi.mock("../actions/tool.actions", () => ({
  executeTool: vi.fn(),
  getToolPermissionStatus: vi.fn(),
  requestToolPermission: vi.fn(),
}));

vi.mock("../state/agent.state", () => ({
  createAgentRunState: () => createAgentRunStateMock(),
}));

vi.mock("../store", () => ({
  getAppState: () => getAppStateMock(),
  produceAppState: (...args: unknown[]) => produceAppStateMock(...args),
}));

vi.mock("../tools", () => ({
  createTool: vi.fn(),
}));

vi.mock("../utils/agent.utils", () => ({
  modifyAgentState: (...args: unknown[]) => modifyAgentStateMock(...args),
}));

vi.mock("../utils/humanize.utils", () => ({
  humanizeScrub: (text: string) => humanizeScrubMock(text),
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

vi.mock("./agent-configs", () => ({}));

describe("runAgent continues after a tool call when the desktop side effect rejects", () => {
  it("isolates a rejected chat-message persistence so the loop yields the next event", async () => {
    const chatMessageById: Record<string, unknown> = {};
    const chatMessageIdsByConversationId: Record<string, string[]> = {
      "c-1": [],
    };
    getAppStateMock.mockReturnValue({
      chatMessageById,
      chatMessageIdsByConversationId,
      agentStateByConversationId: {},
      toolInfoById: {},
    });
    produceAppStateMock.mockImplementation(() => undefined);
    createAgentRunStateMock.mockReturnValue({ status: "calling-llm" });
    humanizeScrubMock.mockImplementation((text: string) => text);
    modifyAgentStateMock.mockImplementation(() => undefined);

    getAgentRepoMock.mockReturnValue({
      repo: { streamChat: vi.fn() },
    });
    // The createChatMessage action (in chat.actions.ts) calls
    // getChatMessageRepo().createChatMessage(). We mock the repo so the
    // action's persistence call rejects with the exact "resource id is
    // invalid" pattern from the user's diagnostics zip. The desktop
    // adapter must isolate that rejection so the for-await loop yields
    // the next event.
    getChatMessageRepoMock.mockReturnValue({
      createChatMessage: (...args: unknown[]) =>
        getChatMessageRepoCreateMock(...args),
    });
    createAgentToolsMock.mockReturnValue([]);

    let repoCreateCalls = 0;
    getChatMessageRepoCreateMock.mockImplementation(async () => {
      repoCreateCalls += 1;
      throw new Error("The resource id 'chat-msg-1' is invalid");
    });

    // The AgentLoop yields: tool-call-start, tool-call-result, text-delta,
    // finish. The test asserts runAgent processes all four despite the
    // persistence rejection in the middle.
    loopRunMock.mockImplementation(() =>
      agentLoopRun([
        {
          type: "tool-call-start",
          toolCallId: "t-1",
          toolName: "noop",
          args: {},
        },
        {
          type: "tool-call-result",
          toolCallId: "t-1",
          toolName: "noop",
          result: "ok",
          isError: false,
        },
        {
          type: "text-delta",
          text: "done",
        },
        {
          type: "finish",
          reason: "stop",
        },
      ]),
    );

    const { runAgent } = await import("./run-agent");
    await expect(
      runAgent("c-1", {
        agentType: "chat",
        systemPrompt: "",
        getToolFilter: () => () => true,
        maxIterations: 4,
      }),
    ).resolves.toBeUndefined();

    // The desktop adapter invoked the repo's createChatMessage once
    // (for the tool result). The rejection must NOT have escaped
    // runAgent — the loop must have continued and resolved normally.
    expect(repoCreateCalls).toBe(1);

    // The rejection was logged with the side-effect label and the
    // conversation + tool-call ids so post-mortem inspection can map it
    // back to the user's diagnostics line.
    const errorMessages = loggerMock.error.mock.calls.map((c) => String(c[0]));
    expect(
      errorMessages.some(
        (m) =>
          m.includes("tool-call-result.persist") &&
          m.includes("toolCallId=t-1"),
      ),
    ).toBe(true);

    // runAgent must NOT have logged an outer "Agent error" — that would
    // mean the for-await loop itself threw, which is the regression.
    expect(errorMessages.some((m) => /^Agent error\b/.test(m))).toBe(false);
  });

  it("retires the streaming entry even when assistant-message persistence rejects", async () => {
    // Sourcery bug_risk: safeSideEffect swallows the finalize rejection,
    // so the in-memory cleanup inside finalizeAssistantMessage must run
    // regardless of the persistence outcome. Without the finally, a
    // failed createChatMessage strands the message in
    // streamingMessageById forever as an indefinitely-streaming bubble.
    const live = {
      chatMessageById: {} as Record<string, unknown>,
      chatMessageIdsByConversationId: { "c-1": [] as string[] },
      agentStateByConversationId: {},
      toolInfoById: {},
      streamingMessageById: {} as Record<string, unknown>,
    };
    getAppStateMock.mockReturnValue(live);
    // Apply state callbacks against the same live object the production
    // reads from, so cleanup effects are observable after the run.
    produceAppStateMock.mockImplementation((fn: (d: unknown) => void) =>
      fn(live),
    );
    createAgentRunStateMock.mockReturnValue({ status: "calling-llm" });
    humanizeScrubMock.mockImplementation((text: string) => `scrubbed:${text}`);
    modifyAgentStateMock.mockImplementation(() => undefined);

    getAgentRepoMock.mockReturnValue({
      repo: { streamChat: vi.fn() },
    });
    getChatMessageRepoMock.mockReturnValue({
      createChatMessage: (...args: unknown[]) =>
        getChatMessageRepoCreateMock(...args),
    });
    createAgentToolsMock.mockReturnValue([]);

    let repoCreateCalls = 0;
    getChatMessageRepoCreateMock.mockImplementation(async () => {
      repoCreateCalls += 1;
      throw new Error("The resource id 'assistant-msg' is invalid");
    });

    // Two iteration rollovers: the second iteration-start finalizes the
    // first assistant message, whose persistence rejects. The loop must
    // still continue to finish — and the streaming entry must be gone.
    loopRunMock.mockImplementation(() =>
      agentLoopRun([
        { type: "iteration-start", iteration: 0 },
        { type: "text-delta", text: "done" },
        { type: "iteration-start", iteration: 1 },
        { type: "finish", reason: "stop" },
      ]),
    );

    const { runAgent } = await import("./run-agent");
    await expect(
      runAgent("c-1", {
        agentType: "chat",
        systemPrompt: "",
        getToolFilter: () => () => true,
        maxIterations: 4,
      }),
    ).resolves.toBeUndefined();

    // Persistence was attempted for both finalized messages (the first
    // message at the rollover, the second at finish) and both rejected.
    expect(repoCreateCalls).toBe(2);
    const errorMessages = loggerMock.error.mock.calls.map((c) => String(c[0]));
    expect(
      errorMessages.some(
        (m) =>
          m.includes("iteration-start.finalizePrevious") &&
          m.includes("The resource id"),
      ),
    ).toBe(true);
    expect(errorMessages.some((m) => /^Agent error\b/.test(m))).toBe(false);

    // THE regression assertion: no message may remain stranded in the
    // streaming map, and the in-memory copy carries the scrubbed final
    // text so the conversation view stays coherent for this session.
    expect(Object.keys(live.streamingMessageById)).toHaveLength(0);
    const assistants = Object.values(live.chatMessageById).filter(
      (m) => (m as { role?: string }).role === "assistant",
    );
    expect(assistants.length).toBeGreaterThan(0);
    expect(
      assistants.some(
        (m) => (m as { content?: string }).content === "scrubbed:done",
      ),
    ).toBe(true);
  });
});
