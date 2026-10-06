// @vitest-environment jsdom

import type { ChatMessage, ChatToolStatus, LlmToolCall } from "@maus-inc/types";

import type { ComputerUseEvent } from "./computer-use-loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultPreferences } from "../../actions/user.actions";
import { getAppState, produceAppState } from "../../store";

/** Events the fake loop yields, replaced per case. */
const scripted: { events: ComputerUseEvent[] } = { events: [] };

/** Set once the fake loop's `abort` runs, so a case can prove it happened. */
const aborts = { count: 0 };

class FakeLoop {
  isRunning = false;
  abort = vi.fn(() => {
    aborts.count += 1;
    this.isRunning = false;
  });
  async *run(signal?: AbortSignal): AsyncGenerator<ComputerUseEvent> {
    this.isRunning = true;
    try {
      for (const event of scripted.events) {
        // The real loop checks the signal before every step, so a stop lands
        // before the next action rather than after it.
        if (signal?.aborted) {
          yield { type: "finish", reason: "aborted" };
          return;
        }
        yield event;
      }
    } finally {
      this.isRunning = false;
    }
  }
}

vi.mock("./computer-use-loop", () => ({ ComputerUseLoop: FakeLoop }));
vi.mock("./run-computer-use", () => ({
  createComputerUseLoop: vi.fn(),
  // The runner deregisters its own loop when it stops driving it, so the mock
  // has to provide it or the import binds to undefined.
  releaseComputerUseLoop: vi.fn(),
}));
vi.mock("../run-agent", () => ({
  safeSideEffect: async (_label: string, _ctx: unknown, fn: () => unknown) =>
    fn(),
}));
vi.mock("../../repos", () => ({
  getChatMessageRepo: () => ({
    createChatMessage: vi.fn(async () => undefined),
    deleteChatMessages: vi.fn(async () => undefined),
  }),
}));

const { runComputerUseForConversation, abortComputerUseRun } =
  await import("./run-computer-use-for-conversation");
const { createComputerUseLoop, releaseComputerUseLoop } =
  await import("./run-computer-use");

/** The loop handed to the runner by the default `beforeEach` stub. */
let loopInstance: FakeLoop;

const CONVERSATION = "conversation-1";

const click = (callId: string, turn = 1): ComputerUseEvent => ({
  type: "action",
  turn,
  callId,
  action: { type: "click", x: 10, y: 20 },
});

const typeAction = (callId: string, turn = 1): ComputerUseEvent => ({
  type: "action",
  turn,
  callId,
  action: { type: "type", text: "hello" },
});

const result = (
  callId: string,
  options: {
    turn?: number;
    success?: boolean;
    skipped?: boolean;
    message?: string;
    permissionId?: string;
  } = {},
): ComputerUseEvent => ({
  type: "action-result",
  turn: options.turn ?? 1,
  result: {
    callId,
    providerName: "stub",
    success: options.success ?? true,
    skipped: options.skipped,
    message: options.message ?? "ok",
  },
  permissionId: options.permissionId,
});

const denied = (permissionId: string): void => {
  produceAppState((draft) => {
    draft.toolPermissionById[permissionId] = {
      id: permissionId,
      toolId: "computer_use:click",
      params: {},
      status: "denied",
      conversationId: CONVERSATION,
      createdAt: Date.now(),
    };
  });
};

const messageIds = (): string[] =>
  getAppState().chatMessageIdsByConversationId[CONVERSATION] ?? [];

const messages = () =>
  messageIds().map((id) => getAppState().chatMessageById[id]!);

/**
 * `ChatMessage.metadata` is `Record<string, unknown>`, so every read below has
 * to narrow. Parsing rather than casting means a shape change in the writer
 * fails the test instead of silently yielding `undefined`.
 *
 * Absent metadata is a legitimate value, not a malformed one: a message with no
 * tool calls persists `null`, because there is nothing to record. So these
 * readers treat absence as empty and only reject a value of the WRONG shape.
 */
const readMetadata = (message?: ChatMessage): Record<string, unknown> => {
  const metadata = message?.metadata;
  if (metadata === null || metadata === undefined) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("message metadata is not an object");
  }
  return metadata;
};

const readToolCalls = (message?: ChatMessage): LlmToolCall[] => {
  const calls = readMetadata(message).toolCalls;
  if (calls === undefined) return [];
  if (!Array.isArray(calls)) {
    throw new Error("metadata.toolCalls is not an array");
  }
  return calls as LlmToolCall[];
};

const readToolStatuses = (
  message?: ChatMessage,
): Record<string, ChatToolStatus> => {
  const statuses = readMetadata(message).toolStatuses;
  if (statuses === undefined) return {};
  if (typeof statuses !== "object" || Array.isArray(statuses)) {
    throw new Error("metadata.toolStatuses is not an object");
  }
  return statuses as Record<string, ChatToolStatus>;
};

beforeEach(() => {
  vi.clearAllMocks();
  aborts.count = 0;
  scripted.events = [];
  produceAppState((draft) => {
    draft.chatMessageById = {};
    draft.chatMessageIdsByConversationId = {};
    draft.streamingMessageById = {};
    draft.toolPermissionById = {};
    draft.agentStateByConversationId = {};
    draft.userPrefs = createDefaultPreferences();
  });
  loopInstance = new FakeLoop();
  vi.mocked(createComputerUseLoop).mockReturnValue({
    ok: true,
    loop: loopInstance as never,
  });
  vi.mocked(releaseComputerUseLoop).mockClear();
});

describe("runComputerUseForConversation", () => {
  it("publishes a status the Stop button can see before the first event", async () => {
    // The opening screenshot is the slowest part of the first turn, and it
    // happens before the loop yields anything. The runner publishes its state
    // first precisely so the Stop control exists during it, which only works if
    // the published status is one `ConversationLayout` reads as running.
    const observed: (string | undefined)[] = [];
    const loop = {
      isRunning: true,
      abort: vi.fn(),
      async *run(): AsyncGenerator<ComputerUseEvent> {
        // Read at the moment the loop would take its first screenshot, which is
        // before any event has been yielded.
        observed.push(
          getAppState().agentStateByConversationId[CONVERSATION]?.status,
        );
        yield { type: "finish", reason: "done", message: "ok" };
      },
    };
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    // `ConversationLayout` treats only these two as running; `idle` is what the
    // chat list reads as "no run", which puts a Send button where Stop belongs.
    expect(["calling-llm", "processing-tools"]).toContain(observed[0]);
  });

  it("creates its message before the loop so an abort cannot strand it", async () => {
    // The run state has to exist before the first event, otherwise a stop
    // during the opening screenshot has nothing to mark aborted and the run
    // carries on. This asserts the state is published even when the loop
    // yields nothing at all.
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: {
        isRunning: true,
        abort: vi.fn(),
        run: async function* run(): AsyncGenerator<ComputerUseEvent> {
          // Yield nothing. A generator that ends immediately.
        },
      } as never,
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    // Nothing was persisted and nothing is left registered, which is the
    // correct end state for a run that produced no turns.
    expect(
      getAppState().agentStateByConversationId[CONVERSATION],
    ).toBeUndefined();
    expect(messageIds()).toHaveLength(0);
  });

  it("refuses a run with no computer-use loop and says why", async () => {
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: false,
      message: "Claude is not registered for computer use.",
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    const run = getAppState().agentStateByConversationId[CONVERSATION];
    expect(run?.status).toBe("error");
    expect(run?.error).toContain("not registered");
    expect(messageIds()).toHaveLength(0);
  });

  it("opens exactly one message per turn and leaves no streaming entry behind", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      { type: "text", text: "First " },
      { type: "text", text: "turn." },
      { ...click("a-1") },
      result("a-1"),
      { type: "finish", reason: "done" },
      { type: "turn-start", turn: 2 },
      { type: "text", text: "Second turn." },
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(messageIds()).toHaveLength(2);
    expect(messages().map((message) => message.content)).toEqual([
      "First turn.",
      "Second turn.",
    ]);
    expect(Object.keys(getAppState().streamingMessageById)).toHaveLength(0);
  });

  it("pairs two same-type actions in one batch by their call ids", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      click("first"),
      click("second"),
      result("first"),
      result("second"),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    const [message] = messages();
    const calls = readToolCalls(message);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.id)).toEqual(["first", "second"]);
    // Both statuses are present and keyed the same way, which is the property a
    // positional pairing would break the moment a batch is trimmed.
    expect(Object.keys(readToolStatuses(message)).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("records a refusal as denied rather than failed", async () => {
    denied("perm-1");
    scripted.events = [
      { type: "turn-start", turn: 1 },
      click("a-1"),
      result("a-1", {
        success: false,
        skipped: true,
        message: "Skipped: you denied it",
        permissionId: "perm-1",
      }),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(readToolStatuses(messages()[0])["a-1"]).toBe("denied");
  });

  /**
   * The store is the only record that anybody agreed to the action, so a
   * refusal the executor did not flag still has to read as one. Without this
   * case the permission id is never load bearing: the other denial tests all
   * set `skipped`, which short-circuits the lookup before the id is read.
   */
  it("reads a refusal the executor did not flag, using the permission id it was asked under", async () => {
    denied("perm-only-store");
    // The run state is torn down when the run ends, so the tool call has to be
    // read while the run is still live. The loop resumes after the runner has
    // handled the previous event, which is exactly the moment a result has been
    // applied and the run state still exists.
    let recordedPermissionId: string | null | undefined;
    const loop = new FakeLoop();
    const original = loop.run.bind(loop);
    loop.run = async function* (signal) {
      for await (const event of original(signal)) {
        yield event;
        if (event.type === "action-result") {
          recordedPermissionId = getAppState().agentStateByConversationId[
            CONVERSATION
          ]?.toolCalls?.find((call) => call.toolCallId === "a-1")?.permissionId;
        }
      }
    } as typeof loop.run;
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });
    scripted.events = [
      { type: "turn-start", turn: 1 },
      click("a-1"),
      result("a-1", {
        success: false,
        message: "the click did not run",
        permissionId: "perm-only-store",
      }),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(readToolStatuses(messages()[0])["a-1"]).toBe("denied");
    expect(recordedPermissionId).toBe("perm-only-store");
  });

  it("gives up the loop when it stops driving it, so the next run is not refused", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      click("a-1"),
      result("a-1"),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(releaseComputerUseLoop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseComputerUseLoop).mock.calls[0][0]).toBe(
      CONVERSATION,
    );
    expect(vi.mocked(releaseComputerUseLoop).mock.calls[0][1]).toBe(
      loopInstance,
    );
  });

  it("reads a refusal from the executor's skipped flag alone", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      typeAction("a-1"),
      result("a-1", {
        success: false,
        skipped: true,
        message: "Skipped: refused",
      }),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(readToolStatuses(messages()[0])["a-1"]).toBe("denied");
  });

  it("records a genuine failure as failed", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      typeAction("a-1"),
      result("a-1", {
        success: false,
        message: "The display went away.",
      }),
      { type: "finish", reason: "done" },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(readToolStatuses(messages()[0])["a-1"]).toBe("failed");
  });

  it("keeps a stuck run's explanation as the message rather than an error", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      {
        type: "finish",
        reason: "stuck",
        message: "The screen stopped changing.",
      },
    ];

    await runComputerUseForConversation(CONVERSATION, "go");

    // The run state is torn down when the run ends, so the only durable place
    // the reason can live is the message itself.
    expect(messages()[0]?.content).toContain("stopped changing");
    expect(
      getAppState().agentStateByConversationId[CONVERSATION],
    ).toBeUndefined();
  });

  it("stops applying events once the caller aborts", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      { type: "text", text: "kept" },
      { ...click("a-1") },
      result("a-1"),
      { type: "finish", reason: "done" },
    ];
    // The abort fires from INSIDE the loop, between the first text and the second,
    // so it lands at a known point in the event stream. A timer would race the
    // generator, and this run is fast enough that a 5 ms wait arrives after
    // every event has already been applied.
    const controller = new AbortController();
    // `isRunning` stays true until aborted, which is what a real loop does: it
    // is mid-turn when the stop arrives, so the teardown path is the one that
    // has to fire.
    const loop = {
      isRunning: true,
      abort: vi.fn(() => {
        loop.isRunning = false;
      }),
      async *run(signal?: AbortSignal): AsyncGenerator<ComputerUseEvent> {
        for (const event of scripted.events) {
          if (signal?.aborted) {
            yield { type: "finish", reason: "aborted" };
            return;
          }
          yield event;
          // Abort immediately after the click's result, which is a result the
          // run was mid-flight on when the stop arrived.
          if (event.type === "action-result") {
            controller.abort();
          }
        }
      },
    };
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });

    const run = runComputerUseForConversation(
      CONVERSATION,
      "go",
      controller.signal,
    );
    await run;

    const persisted = messages()[0];
    expect(persisted?.content).toBe("kept");
    expect(readToolCalls(persisted).map((call) => call.id)).toEqual(["a-1"]);
    // The action that was already running when the stop arrived still reports
    // its outcome. A stopped run still owns the conversation, so its in-flight
    // result is the one thing the user most needs to see.
    expect(readToolStatuses(persisted)["a-1"]).toBe("complete");
    // And the stop itself is recorded, so the chat shows why the run ended.
    expect(readMetadata(persisted).runOutcome).toBe("aborted");
    // The loop is aborted, not merely ignored. Leaving it running means the
    // next action still executes against the real screen after the user asked
    // to stop, and ground rule 9 puts a 500ms ceiling on exactly that.
    expect(loop.abort).toHaveBeenCalled();
    expect(
      getAppState().agentStateByConversationId[CONVERSATION],
    ).toBeUndefined();
  });

  it("does not abort a loop that already finished on its own", async () => {
    scripted.events = [{ type: "finish", reason: "done" }];

    await runComputerUseForConversation(CONVERSATION, "go");

    // Aborting an already-stopped loop is how a superseded run's cleanup
    // tears down the NEWER run's loop. The real loop is tracked per
    // conversation and this one is finished, so nothing should be aborted.
    expect(aborts.count).toBe(0);
  });

  it("gives up the conversation when another run takes it over", async () => {
    scripted.events = [
      { type: "turn-start", turn: 1 },
      { type: "text", text: "before" },
      // Standing in for a tool-calling run that replaced this run's state
      // between the second and third event.
      { type: "text", text: "after" },
    ];
    const loop = {
      isRunning: true,
      abort: vi.fn(),
      async *run(): AsyncGenerator<ComputerUseEvent> {
        for (const event of scripted.events) {
          // A tool-calling run replaces this run's agent state between the two
          // text events, which is what a superseding run looks like from here.
          if (event.type === "text" && event.text === "after") {
            produceAppState((draft) => {
              draft.agentStateByConversationId[CONVERSATION] = {
                status: "calling-llm",
                agentType: "chat",
                iteration: 1,
                maxIterations: 10,
                toolCalls: [],
                currentToolIndex: 0,
                aborted: false,
              };
            });
          }
          yield event;
        }
      },
    };
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(loop.abort).toHaveBeenCalled();
    // The event that revealed the takeover must not have been applied, and this
    // run never persisted, so its message must be gone rather than left in the
    // conversation as an empty bubble. Asserting the message survived used to be
    // this test's third assertion, which is why the leak looked intentional.
    expect(messageIds()).toHaveLength(0);
    expect(
      getAppState().agentStateByConversationId[CONVERSATION]?.agentType,
    ).toBe("chat");
  });

  it("takes its own half-written message away when it loses the conversation", async () => {
    // A run that loses ownership never reaches `persistCurrentMessage`, so
    // without the cleanup its message stays in the conversation for the rest of
    // the session: visible, empty, and undeletable by the user.
    const loop = {
      isRunning: true,
      abort: vi.fn(),
      async *run(): AsyncGenerator<ComputerUseEvent> {
        yield { type: "turn-start", turn: 1 };
        yield { type: "text", text: "half written" };
        produceAppState((draft) => {
          draft.agentStateByConversationId[CONVERSATION] = {
            status: "calling-llm",
            agentType: "chat",
            iteration: 1,
            maxIterations: 10,
            toolCalls: [],
            currentToolIndex: 0,
            aborted: false,
          };
        });
      },
    };
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(messageIds()).toHaveLength(0);
    expect(Object.keys(getAppState().chatMessageById)).toHaveLength(0);
  });

  it("aborts a live run when abortComputerUseRun is called", async () => {
    const loop = new FakeLoop();
    loop.isRunning = true;
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: loop as never,
    });
    produceAppState((draft) => {
      draft.agentStateByConversationId[CONVERSATION] = {
        status: "processing-tools",
        agentType: "computer_use",
        iteration: 1,
        maxIterations: 30,
        toolCalls: [],
        currentToolIndex: 0,
        aborted: false,
      };
    });

    abortComputerUseRun(CONVERSATION);

    expect(
      getAppState().agentStateByConversationId[CONVERSATION]?.aborted,
    ).toBe(true);
  });

  it("reports a thrown adapter as an error the user can see", async () => {
    vi.mocked(createComputerUseLoop).mockReturnValue({
      ok: true,
      loop: {
        isRunning: true,
        abort: vi.fn(),
        // eslint-disable-next-line require-yield
        run: async function* run(): AsyncGenerator<ComputerUseEvent> {
          throw new Error("the adapter exploded");
        },
      } as never,
    });

    await runComputerUseForConversation(CONVERSATION, "go");

    expect(
      getAppState().agentStateByConversationId[CONVERSATION],
    ).toBeUndefined();
    expect(readMetadata(messages()[0]).runOutcome).toBe("error");
  });
});
