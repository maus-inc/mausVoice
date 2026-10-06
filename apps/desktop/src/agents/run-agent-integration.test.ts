import { beforeEach, describe, expect, it, vi } from "vitest";
import { produce } from "immer";
import { INITIAL_APP_STATE } from "../state/app.state";
import type { AppState } from "../state/app.state";
import type { AgentConfig } from "@repo/agent";
import type { ToolInfo } from "@maus-inc/types";
import { createTool } from "../tools";
import { executeTool, requestToolPermission } from "../actions/tool.actions";

const {
  loopRunMock,
  loopConfigMock,
  getAgentRepoMock,
  getChatMessageRepoMock,
  getAppStateMock,
  produceAppStateMock,
  createAgentRunStateMock,
  createAgentToolsMock,
  humanizeScrubMock,
  modifyAgentStateMock,
  getChatMessageRepoCreateMock,
  getToolPermissionStatusMock,
  agentLoopRun,
  loggerMock,
} = vi.hoisted(() => {
  const loopRunMock = vi.fn();
  const loopConfigMock = vi.fn<(config: AgentConfig) => void>();
  const getAgentRepoMock = vi.fn();
  const getChatMessageRepoMock = vi.fn();
  const getAppStateMock = vi.fn();
  const produceAppStateMock = vi.fn();
  const createAgentRunStateMock = vi.fn();
  const createAgentToolsMock = vi.fn();
  const humanizeScrubMock = vi.fn();
  const modifyAgentStateMock = vi.fn();
  const getChatMessageRepoCreateMock = vi.fn();
  const getToolPermissionStatusMock = vi.fn();
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
    loopConfigMock,
    getAgentRepoMock,
    getChatMessageRepoMock,
    getAppStateMock,
    produceAppStateMock,
    createAgentRunStateMock,
    createAgentToolsMock,
    humanizeScrubMock,
    modifyAgentStateMock,
    getChatMessageRepoCreateMock,
    getToolPermissionStatusMock,
    agentLoopRun,
    loggerMock,
  };
});

vi.mock("@repo/agent", () => {
  class AgentLoop {
    constructor(config: AgentConfig) {
      loopConfigMock(config);
    }
    private readonly runImpl = loopRunMock;
    abort = vi.fn();
    run(...args: unknown[]) {
      return this.runImpl(...args);
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
  getToolPermissionStatus: getToolPermissionStatusMock,
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

/**
 * Wire the mocks that every runAgent integration test shares: a repo that
 * streams chat, a chat-message repo that delegates to the create mock, an
 * empty tool set, an LLM-calling run state, and a no-op agent-state modifier.
 * Each test layers its own app-state and scrub behavior on top.
 */
const setupAgentMocks = () => {
  createAgentRunStateMock.mockReturnValue({ status: "calling-llm" });
  modifyAgentStateMock.mockImplementation(() => undefined);
  getAgentRepoMock.mockReturnValue({ repo: { streamChat: vi.fn() } });
  getChatMessageRepoMock.mockReturnValue({
    createChatMessage: (...args: unknown[]) =>
      getChatMessageRepoCreateMock(...args),
  });
  createAgentToolsMock.mockReturnValue([]);
};

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
    humanizeScrubMock.mockImplementation((text: string) => text);
    setupAgentMocks();

    let repoCreateCalls = 0;
    getChatMessageRepoCreateMock.mockImplementation(() => {
      repoCreateCalls += 1;
      return Promise.reject(
        new Error("The resource id 'chat-msg-1' is invalid"),
      );
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
          m.includes('toolCallId="t-1"'),
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
    humanizeScrubMock.mockImplementation((text: string) => `scrubbed:${text}`);
    setupAgentMocks();

    let repoCreateCalls = 0;
    getChatMessageRepoCreateMock.mockImplementation(() => {
      repoCreateCalls += 1;
      return Promise.reject(
        new Error("The resource id 'assistant-msg' is invalid"),
      );
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

describe("pollForPermission", () => {
  it("waits for the permission store to record timeout denial", async () => {
    vi.useFakeTimers();
    getAppStateMock.mockReturnValue({ agentStateByConversationId: {} });
    const startedAt = Date.now();
    getToolPermissionStatusMock.mockImplementation(() =>
      Date.now() - startedAt >= 1_000 ? { status: "denied" } : null,
    );

    try {
      const { pollForPermission } = await import("./run-agent");
      const result = pollForPermission("c-1", "permission-1");

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe("denied");
      expect(getToolPermissionStatusMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runAgent supersession (one live loop per conversation)", () => {
  it("a newer run aborts the older one and Stop still reaches the newest", async () => {
    // Two concurrent sends for one conversation (dashboard send in flight,
    // pill-typed send arrives) used to let the second runAgent clobber the
    // first's active-loop registration; the first run's cleanup then
    // deleted the SECOND run's entry, leaving the live loop un-abortable
    // (Stop button silently stopped working).
    const loops: Array<{ abort: ReturnType<typeof vi.fn> }> = [];
    let release2: () => void = () => undefined;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let call = 0;
    loopRunMock.mockImplementation(function (this: {
      abort: ReturnType<typeof vi.fn>;
    }) {
      call += 1;
      loops.push(this);
      if (call === 1) {
        return agentLoopRun([{ type: "finish", reason: "stop" }]);
      }
      async function* second() {
        yield { type: "iteration-start", iteration: 0 };
        await gate2;
        yield { type: "finish", reason: "stop" };
      }
      return second();
    });

    const live = {
      chatMessageById: {} as Record<string, unknown>,
      chatMessageIdsByConversationId: { "c-2": [] as string[] },
      agentStateByConversationId: {},
      toolInfoById: {},
      streamingMessageById: {} as Record<string, unknown>,
    };
    getAppStateMock.mockReturnValue(live);
    produceAppStateMock.mockImplementation(() => undefined);
    humanizeScrubMock.mockImplementation((text: string) => text);
    setupAgentMocks();
    getChatMessageRepoCreateMock.mockImplementation(() => Promise.resolve({}));

    const { runAgent, abortAgentLoop } = await import("./run-agent");
    const config = {
      agentType: "chat",
      systemPrompt: "",
      getToolFilter: () => () => true,
      maxIterations: 4,
    };

    // Registration is synchronous: when runAgent returns its promise the
    // loop is already in the module's active-loop map.
    const run1 = runAgent("c-2", config);
    const run2 = runAgent("c-2", config);

    // The older loop was superseded the moment the newer run started.
    expect(loops).toHaveLength(2);
    expect(loops[0].abort).toHaveBeenCalledTimes(1);
    expect(loops[1].abort).toHaveBeenCalledTimes(0);

    await run1;
    // The older run finished AFTER the newer run took over. Its cleanup
    // must not have removed the newer loop's registration.
    abortAgentLoop("c-2");
    expect(loops[1].abort).toHaveBeenCalledTimes(1);

    release2();
    await run2;
  });
});

describe("runAgent replay filter and unfinished tool turns", () => {
  it("leaves out a tool turn whose result has not landed yet", async () => {
    // `isStreaming` is cleared at the first `tool-call-start`, which is before
    // any of that turn's tool results are persisted. Replaying on that flag
    // alone hands the next run a half-finished assistant turn, tool calls
    // included, with no matching `tool` message behind it. A message is safe to
    // replay only once it has stopped streaming *and* every tool call it
    // declared has come back done.
    // `loopRunMock` is shared across this file's suites, and the argument under
    // test is the first call's, so the earlier suites' calls have to go.
    loopRunMock.mockClear();
    getChatMessageRepoCreateMock.mockClear();
    loggerMock.verbose.mockClear();

    const chatMessageById: Record<string, unknown> = {
      // A finished turn: streamed, one tool call, that call done. Replayable.
      "m-done": {
        id: "m-done",
        role: "assistant",
        content: "finished turn",
        metadata: {
          type: undefined,
          toolCalls: [{ id: "call-done", name: "noop", arguments: "{}" }],
        },
      },
      "r-done": {
        id: "r-done",
        role: "system",
        content: "result for the finished call",
        metadata: { type: "tool-result", toolCallId: "call-done" },
      },
      // A turn caught mid-tool: not streaming, but its call has not come back.
      "m-pending": {
        id: "m-pending",
        role: "assistant",
        content: "half a turn",
        metadata: {
          toolCalls: [{ id: "call-pending", name: "noop", arguments: "{}" }],
        },
      },
    };
    const live = {
      chatMessageById,
      chatMessageIdsByConversationId: {
        "c-4": ["m-done", "r-done", "m-pending"],
      },
      agentStateByConversationId: {},
      toolInfoById: {},
      streamingMessageById: {
        // `isStreaming` already false: the first tool call started.
        "m-pending": {
          isStreaming: false,
          toolCalls: [
            { toolCallId: "call-pending", toolName: "noop", done: false },
          ],
        },
      },
    };
    getAppStateMock.mockReturnValue(live);
    produceAppStateMock.mockImplementation(() => undefined);
    humanizeScrubMock.mockImplementation((text: string) => text);
    setupAgentMocks();
    getChatMessageRepoCreateMock.mockResolvedValue({});

    loopRunMock.mockImplementation(() =>
      agentLoopRun([{ type: "finish", reason: "stop" }]),
    );

    const { runAgent } = await import("./run-agent");
    await runAgent("c-4", {
      agentType: "chat",
      systemPrompt: "",
      getToolFilter: () => () => true,
      maxIterations: 4,
    });

    const sent = loopRunMock.mock.calls[0]?.[0] as
      | Array<{
          role: string;
          content?: string;
          toolCallId?: string;
        }>
      | undefined;
    // A real narrowing rather than `expect(...).toBeDefined()` plus `!`. The
    // assertion does not narrow the type, so the `!` it needed was a claim the
    // compiler could not check, and DeepScan reported the access as a null
    // dereference on exactly that basis. Throwing narrows for real, keeps the
    // failure message, and drops four `!` assertions from this file.
    if (!sent) {
      throw new Error("the agent never reached the provider loop");
    }
    const contents = sent.map((m) => m.content);

    expect(contents).toContain("finished turn");
    expect(
      contents,
      "a tool call with no result yet was replayed into the next run",
    ).not.toContain("half a turn");
    // And the finished call's result is still there, so the filter is not simply
    // dropping every tool turn.
    expect(
      sent.some((m) => m.role === "tool" && m.toolCallId === "call-done"),
    ).toBe(true);
    // No `tool` message exists for the pending call, so none may be invented.
    expect(sent.some((m) => m.toolCallId === "call-pending")).toBe(false);
  });
});

describe("runAgent supersession while a tool result is being written", () => {
  it("takes the tool result back out when the replacement run takes over mid-write", async () => {
    // The window is the await inside the tool-result write: a second run for the
    // same conversation registers while the first run's write is in flight, so
    // the context the replacement snapshotted cannot contain that result. Left
    // committed it becomes a `tool` message whose `tool_calls` entry no live
    // turn declares, which the next run rehydrates and providers reject. Both
    // edges are checked, so the row is removed again from the store and state.
    const chatMessageById: Record<string, unknown> = {};
    const chatMessageIdsByConversationId: Record<string, string[]> = {
      "c-3": [],
    };
    const live = {
      chatMessageById,
      chatMessageIdsByConversationId,
      agentStateByConversationId: {},
      toolInfoById: {},
      streamingMessageById: {} as Record<string, unknown>,
    };
    // Earlier suites in this file leave calls on the shared hoisted mocks, and
    // the wait below counts them, so start from zero rather than from whatever
    // the previous test left behind.
    getChatMessageRepoCreateMock.mockClear();
    loggerMock.verbose.mockClear();
    getAppStateMock.mockReturnValue(live);
    produceAppStateMock.mockImplementation(() => undefined);
    humanizeScrubMock.mockImplementation((text: string) => text);
    setupAgentMocks();

    const deleteChatMessagesMock = vi.fn().mockResolvedValue(undefined);
    getChatMessageRepoMock.mockReturnValue({
      createChatMessage: (...args: unknown[]) =>
        getChatMessageRepoCreateMock(...args),
      deleteChatMessages: (...args: unknown[]) =>
        deleteChatMessagesMock(...args),
    });

    // The write is parked here, which is the whole point: run1 is inside
    // `createChatMessage` when run2 registers.
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    getChatMessageRepoCreateMock.mockImplementation(async (message) => {
      await writeGate;
      return message;
    });

    let call = 0;
    loopRunMock.mockImplementation(function (this: {
      abort: ReturnType<typeof vi.fn>;
    }) {
      call += 1;
      if (call === 1) {
        return agentLoopRun([
          { type: "iteration-start", iteration: 0 },
          {
            type: "tool-call-start",
            toolCallId: "t-9",
            toolName: "noop",
            args: {},
          },
          {
            type: "tool-call-result",
            toolCallId: "t-9",
            toolName: "noop",
            result: "ok",
            isError: false,
          },
          { type: "finish", reason: "stop" },
        ]);
      }
      async function* second() {
        yield { type: "iteration-start", iteration: 0 };
        yield { type: "finish", reason: "stop" };
      }
      return second();
    });

    const { runAgent } = await import("./run-agent");
    const config = {
      agentType: "chat",
      systemPrompt: "",
      getToolFilter: () => () => true,
      maxIterations: 4,
    };

    const run1 = runAgent("c-3", config);
    // Wait until run1 is genuinely inside the write, not merely started.
    await vi.waitFor(() =>
      expect(getChatMessageRepoCreateMock).toHaveBeenCalledTimes(1),
    );

    const run2 = runAgent("c-3", config);
    releaseWrite();

    await run1;
    await run2;

    // The write was issued, then withdrawn, and the id it used is the one removed.
    const issued = getChatMessageRepoCreateMock.mock.calls[0]?.[0] as
      { id: string } | undefined;
    // Real narrowing for the same reason as the `sent` binding above: an
    // assertion cannot satisfy a nullability check, so the `!` it needed was
    // itself what DeepScan flagged.
    if (!issued) {
      throw new Error("no tool result was persisted");
    }
    // The mock stands in for the repository method, which `deleteChatMessages`
    // calls with the id list alone; the conversation id is only used to prune
    // state.
    expect(deleteChatMessagesMock).toHaveBeenCalledWith([issued.id]);

    const verbose = loggerMock.verbose.mock.calls.map((c) => String(c[0]));
    expect(
      verbose.some((m) => m.includes("Rolled back tool-result persist")),
      "the rollback was not reported",
    ).toBe(true);
  });
});

describe("runAgent immutable-state lifecycle", () => {
  let live: AppState;
  const config = {
    agentType: "chat",
    systemPrompt: "",
    getToolFilter: () => () => true,
    maxIterations: 4,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setupAgentMocks();
    live = structuredClone(INITIAL_APP_STATE);
    getAppStateMock.mockImplementation(() => live);
    produceAppStateMock.mockImplementation(
      (recipe: (draft: AppState) => void) => {
        live = produce(live, recipe);
      },
    );
    const { createAgentRunState } = await vi.importActual<
      typeof import("../state/agent.state")
    >("../state/agent.state");
    const { modifyAgentState } = await vi.importActual<
      typeof import("../utils/agent.utils")
    >("../utils/agent.utils");
    createAgentRunStateMock.mockImplementation(() =>
      createAgentRunState("chat", 4),
    );
    modifyAgentStateMock.mockImplementation(modifyAgentState);
  });

  it.each(["complete", "failed", "denied"] as const)(
    "persists and reloads %s tool outcomes without live permissions",
    async (status) => {
      humanizeScrubMock.mockImplementation((text: string) => text);
      getChatMessageRepoCreateMock.mockImplementation((message) =>
        Promise.resolve(message),
      );
      loopRunMock.mockImplementation(async function* () {
        yield { type: "iteration-start", iteration: 0 };
        yield {
          type: "tool-call-start",
          toolCallId: "call",
          toolName: "paste",
          args: {},
        };
        if (status === "denied") {
          live = produce(live, (draft) => {
            draft.toolPermissionById.permission = {
              id: "permission",
              toolId: "paste",
              toolCallId: "call",
              conversationId: "outcomes",
              params: {},
              status: "denied",
              createdAt: 0,
            };
            draft.agentStateByConversationId.outcomes.toolCalls[0].permissionId =
              "permission";
          });
        }
        yield {
          type: "tool-call-result",
          toolCallId: "call",
          toolName: "paste",
          result: "result",
          isError: status !== "complete",
        };
        expect(
          live.agentStateByConversationId.outcomes.toolCalls[0].status,
        ).toBe(status === "complete" ? "done" : status);
        yield { type: "finish", reason: "stop" };
      });
      const { runAgent } = await import("./run-agent");
      await runAgent("outcomes", config);
      const stored = getChatMessageRepoCreateMock.mock.calls.map(
        ([message]) => message,
      );
      const assistant = stored.find((message) => message.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant.metadata.toolStatuses).toEqual({ call: status });
      const { partsForMessage } = await import("../utils/chat-parts.utils");
      expect(
        partsForMessage({ message: JSON.parse(JSON.stringify(assistant)) }),
      ).toEqual([
        { kind: "tool", toolCallId: "call", toolName: "paste", status },
      ]);
      expect(
        stored.find((message) => message.metadata?.type === "tool-result")
          ?.metadata.status,
      ).toBe(status);
    },
  );

  it("does not leave idle state behind when provider setup fails", async () => {
    getAgentRepoMock.mockReturnValue({ repo: null });
    const { runAgent } = await import("./run-agent");
    await expect(runAgent("setup-failure", config)).rejects.toThrow(
      "No LLM provider configured",
    );
    expect(live.agentStateByConversationId["setup-failure"]).toBeUndefined();
  });

  it("cleans up after Immer replaces the original run-state object", async () => {
    loopRunMock.mockImplementation(() =>
      agentLoopRun([
        { type: "iteration-start", iteration: 0 },
        { type: "finish", reason: "stop" },
      ]),
    );
    const { runAgent } = await import("./run-agent");
    await runAgent("immutable-cleanup", config);
    expect(
      live.agentStateByConversationId["immutable-cleanup"],
    ).toBeUndefined();
  });

  it.each(["stopped", "superseded", "deleted"] as const)(
    "does not execute a late-approved tool after its run is %s",
    async (termination) => {
      vi.useFakeTimers();
      const info: ToolInfo = {
        id: "test-tool",
        description: "test",
        instructions: "",
        schema: {},
        risk: "medium",
      };
      live.toolInfoById[info.id] = info;
      vi.mocked(createTool).mockReturnValue({
        info,
        execute: vi.fn(),
        getAlwaysAllow: () => false,
        setAlwaysAllow: vi.fn(),
      });
      vi.mocked(requestToolPermission).mockReturnValue("old-permission");
      getToolPermissionStatusMock.mockReturnValue(null);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      loopRunMock.mockImplementation(async function* () {
        await gate;
        yield { type: "finish", reason: "stop" };
      });
      const { runAgent, abortAgentLoop } = await import("./run-agent");
      const oldRun = runAgent("late-approval", config);
      let newRun: Promise<void> | undefined;
      try {
        const tool = loopConfigMock.mock.calls[0][0].tools[0];
        const pending = tool.execute({
          params: {},
          reason: "test",
          toolCallId: "tc-old",
        });
        expect(getToolPermissionStatusMock).toHaveBeenCalledWith(
          "old-permission",
        );
        if (termination === "superseded") {
          newRun = runAgent("late-approval", config);
        } else {
          abortAgentLoop("late-approval");
          if (termination === "deleted") {
            produceAppStateMock((draft: AppState) => {
              delete draft.agentStateByConversationId["late-approval"];
            });
          }
        }
        getToolPermissionStatusMock.mockReturnValue({ status: "allowed" });
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: false });
        expect(executeTool).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.all([oldRun, newRun]);
        vi.useRealTimers();
      }
    },
  );

  it("does not let a superseded run finish or erase its replacement", async () => {
    let releaseOld = () => {};
    let releaseNew = () => {};
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    loopRunMock.mockImplementationOnce(async function* () {
      await oldGate;
      yield { type: "finish", reason: "stop" };
    });
    loopRunMock.mockImplementationOnce(async function* () {
      yield { type: "iteration-start", iteration: 0 };
      await newGate;
      yield { type: "finish", reason: "stop" };
    });
    const { runAgent } = await import("./run-agent");
    const oldRun = runAgent("superseded-state", config);
    const newRun = runAgent("superseded-state", config);
    try {
      await vi.waitFor(() =>
        expect(
          live.agentStateByConversationId["superseded-state"]?.status,
        ).toBe("calling-llm"),
      );
      releaseOld();
      await oldRun;
      expect(live.agentStateByConversationId["superseded-state"]?.status).toBe(
        "calling-llm",
      );
    } finally {
      releaseOld();
      releaseNew();
      await Promise.all([oldRun, newRun]);
    }
    expect(live.agentStateByConversationId["superseded-state"]).toBeUndefined();
  });

  it.each([
    ["error", false],
    ["aborted", false],
    ["error", true],
    ["aborted", true],
  ] as const)(
    "persists %s after cleanup (tool tail: %s)",
    async (reason, withTool) => {
      humanizeScrubMock.mockImplementation((text: string) => text);
      getChatMessageRepoCreateMock.mockImplementation((message) =>
        Promise.resolve(message),
      );
      loopRunMock.mockImplementation(async function* () {
        yield { type: "iteration-start", iteration: 0 };
        yield { type: "text-delta", text: "Partial answer" };
        if (withTool) {
          yield {
            type: "tool-call-start",
            toolCallId: "call",
            toolName: "paste",
            args: {},
          };
          yield {
            type: "tool-call-result",
            toolCallId: "call",
            toolName: "paste",
            result: "result",
            isError: false,
          };
        }
        yield {
          type: "finish",
          reason,
          error: reason === "error" ? "Private provider diagnostic" : undefined,
        };
      });
      const { runAgent } = await import("./run-agent");
      await runAgent("run-outcome", config);
      expect(live.agentStateByConversationId["run-outcome"]).toBeUndefined();
      expect(live.streamingMessageById).toEqual({});
      const stored = getChatMessageRepoCreateMock.mock.calls.map(
        ([message]) => message,
      );
      const assistant = stored
        .filter((message) => message.role === "assistant")
        .at(-1);
      expect(assistant).toBeDefined();
      const reloaded = JSON.parse(JSON.stringify(assistant));
      expect(reloaded.content).toBe("Partial answer");
      expect(reloaded.metadata.runOutcome).toBe(reason);
      expect(JSON.stringify(reloaded)).not.toContain(
        "Private provider diagnostic",
      );
      if (withTool)
        expect(reloaded.metadata.toolStatuses).toEqual({ call: "complete" });
    },
  );

  it("finalizes an unexpected adapter failure with a durable generic outcome", async () => {
    humanizeScrubMock.mockImplementation((text: string) => text);
    getChatMessageRepoCreateMock.mockImplementation((message) =>
      Promise.resolve(message),
    );
    loopRunMock.mockImplementation(async function* () {
      yield { type: "iteration-start", iteration: 0 };
      yield { type: "text-delta", text: "Partial answer" };
      throw new Error("Private provider diagnostic");
    });
    const { runAgent } = await import("./run-agent");
    await runAgent("adapter-failure", config);
    const stored = getChatMessageRepoCreateMock.mock.calls.map(
      ([message]) => message,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].metadata).toEqual({ runOutcome: "error" });
    expect(stored[0].content).toBe("Partial answer");
    expect(live.agentStateByConversationId["adapter-failure"]).toBeUndefined();
  });

  it("retains the run outcome for the session if its durable write fails", async () => {
    humanizeScrubMock.mockImplementation((text: string) => text);
    getChatMessageRepoCreateMock.mockRejectedValue(new Error("disk failure"));
    loopRunMock.mockImplementation(() =>
      agentLoopRun([
        { type: "iteration-start", iteration: 0 },
        { type: "finish", reason: "error", error: "Provider failed" },
      ]),
    );
    const { runAgent } = await import("./run-agent");
    await runAgent("outcome-write-failure", config);
    const [message] = Object.values(live.chatMessageById);
    expect(message.metadata).toEqual({ runOutcome: "error" });
    expect(live.streamingMessageById).toEqual({});
  });

  it("does not include active streaming assistant messages in a replacement run message snapshot", async () => {
    let capturedMessagesSecondRun: unknown[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    loopRunMock.mockImplementationOnce(async function* () {
      yield { type: "iteration-start", iteration: 0 };
      yield { type: "text-delta", text: "Partial unfinished response" };
      await firstGate;
      yield { type: "finish", reason: "stop" };
    });

    loopRunMock.mockImplementationOnce((messages: unknown[]) => {
      capturedMessagesSecondRun = messages;
      return agentLoopRun([
        { type: "iteration-start", iteration: 0 },
        { type: "finish", reason: "stop" },
      ]);
    });

    const { runAgent } = await import("./run-agent");
    const run1 = runAgent("superseded-snapshot", config);

    await vi.waitFor(() => {
      const msgs = Object.values(live.chatMessageById);
      expect(
        msgs.some(
          (m) =>
            (m as { content?: string }).content ===
            "Partial unfinished response",
        ),
      ).toBe(true);
    });

    const run2 = runAgent("superseded-snapshot", config);

    releaseFirst();
    await Promise.all([run1, run2]);

    expect(
      capturedMessagesSecondRun.some((m) => {
        const message = m as { role?: string; content?: string };
        return (
          message.role === "assistant" &&
          message.content?.includes("Partial unfinished response")
        );
      }),
    ).toBe(false);
  });
});

describe("runAgent risk-tier gating", () => {
  let live: AppState;
  const config = {
    agentType: "chat",
    systemPrompt: "",
    getToolFilter: () => () => true,
    maxIterations: 4,
  };

  const registerToolAtRisk = (risk: ToolInfo["risk"]) => {
    const info: ToolInfo = {
      id: "tiered-tool",
      description: "A tool whose risk decides whether it asks",
      instructions: "",
      schema: {},
      risk,
    };
    live.toolInfoById[info.id] = info;
    return info;
  };

  /** Drive one tool call through the real permission path and return its output. */
  const runTieredTool = async (risk: ToolInfo["risk"]) => {
    const info = registerToolAtRisk(risk);
    const execute = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createTool).mockReturnValue({
      info,
      execute,
      getAlwaysAllow: () => false,
      setAlwaysAllow: vi.fn(),
    });
    // The tool has to run while the loop is still live: `executeWithPermission`
    // checks `isActive()` first, and `activeLoops` is pruned once the run
    // returns. Holding the generator open is what keeps the test on the branch
    // it is meant to cover.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loopRunMock.mockImplementation(async function* () {
      yield { type: "iteration-start", iteration: 0 };
      await gate;
      yield { type: "finish", reason: "stop" };
    });
    const { runAgent } = await import("./run-agent");
    const run = runAgent(`tier-${risk}`, config);
    await vi.waitFor(() =>
      expect(loopConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ tools: expect.any(Array) }),
      ),
    );
    const tools = loopConfigMock.mock.calls.at(-1)?.[0].tools ?? [];
    try {
      return await tools[0].execute({
        params: {},
        reason: "test",
        toolCallId: "tc-1",
      });
    } finally {
      release();
      await run;
    }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setupAgentMocks();
    live = structuredClone(INITIAL_APP_STATE);
    getAppStateMock.mockImplementation(() => live);
    produceAppStateMock.mockImplementation(
      (recipe: (draft: AppState) => void) => {
        live = produce(live, recipe);
      },
    );
    humanizeScrubMock.mockImplementation((text: string) => text);
    getChatMessageRepoCreateMock.mockImplementation((message) =>
      Promise.resolve(message),
    );
    const { createAgentRunState } = await vi.importActual<
      typeof import("../state/agent.state")
    >("../state/agent.state");
    const { modifyAgentState } = await vi.importActual<
      typeof import("../utils/agent.utils")
    >("../utils/agent.utils");
    createAgentRunStateMock.mockImplementation(() =>
      createAgentRunState("chat", 4),
    );
    modifyAgentStateMock.mockImplementation(modifyAgentState);
  });

  it("runs a low risk tool without asking the user", async () => {
    await runTieredTool("low");
    // Nothing was registered as pending, so the poll would never resolve and
    // the tool would never run. Reaching an execute at all is the assertion.
    expect(requestToolPermission).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it.each(["medium", "high"] as const)(
    "asks the user before running a %s risk tool",
    async (risk) => {
      vi.mocked(requestToolPermission).mockReturnValue("perm-1");
      getToolPermissionStatusMock.mockReturnValue({ status: "allowed" });
      await runTieredTool(risk);
      expect(requestToolPermission).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledTimes(1);
    },
  );

  it("runs a denied tool's output as a failure rather than as a result", async () => {
    vi.mocked(requestToolPermission).mockReturnValue("perm-1");
    getToolPermissionStatusMock.mockReturnValue({ status: "denied" });
    const output = await runTieredTool("high");
    expect(executeTool).not.toHaveBeenCalled();
    expect(output).toMatchObject({ success: false });
  });
});
