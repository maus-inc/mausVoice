// @vitest-environment jsdom

import type {
  CaptureRequest,
  CapturedFrame,
  PhysicalRect,
} from "@maus-inc/desktop-native-apis";
import type { ComputerUseHost } from "./computer-use-executor";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every call the loop makes to the machine, in order.
 *
 * The assertions in this file are about what the loop asked the operating
 * system to do. A run that sets an `aborted` flag on a state object and then
 * keeps clicking has set a flag and done nothing else, which is why the older
 * stop test asserted the flag and proved nothing.
 */
const { machine } = vi.hoisted(() => ({
  machine: { calls: [] as string[], turnDelayMs: 25 },
}));

/**
 * How long one turn takes on the fake machine.
 *
 * This is what makes the test meaningful. With an instant host the whole run
 * finishes inside a single macrotask, so there is no moment at which Stop could
 * possibly land, and an assertion after it holds whatever the code does.
 */
const TURN_DELAY_MS = 25;

/** Long enough for several turns to be in flight, short enough to stay quick. */
const RUN_FOR_MS = 150;

vi.mock("./tauri-computer-use.host", () => {
  const note = (name: string) => async () => {
    machine.calls.push(name);
  };
  const host = {
    listDisplays: async () => {
      machine.calls.push("listDisplays");
      return [
        {
          id: 1,
          originX: 0,
          originY: 0,
          widthPx: 1920,
          heightPx: 1080,
          scaleFactor: 1,
        },
      ];
    },
    captureScreen: async (
      _request?: CaptureRequest,
    ): Promise<CapturedFrame> => {
      await new Promise((resolve) => setTimeout(resolve, TURN_DELAY_MS));
      machine.calls.push("captureScreen");
      return {
        data: `frame-${machine.calls.length}`,
        mimeType: "image/png",
        imageWidth: 1280,
        imageHeight: 720,
        sourceWidth: 1920,
        sourceHeight: 1080,
        displayId: 1,
      };
    },
    captureScreenRegion: async (
      _frame: CapturedFrame,
      _region: PhysicalRect,
    ): Promise<CapturedFrame> => ({
      data: "region",
      mimeType: "image/png",
      imageWidth: 64,
      imageHeight: 64,
      sourceWidth: 64,
      sourceHeight: 64,
      displayId: 1,
    }),
    computerUsePointerPosition: async (): Promise<[number, number]> => [0, 0],
    computerUseMove: note("move"),
    computerUseClick: async () => {
      machine.calls.push("click");
    },
    computerUsePressButton: note("pressButton"),
    computerUseReleaseButton: note("releaseButton"),
    computerUseDrag: note("drag"),
    computerUseScroll: note("scroll"),
    computerUsePressKey: note("pressKey"),
    computerUsePressKeyDown: note("pressKeyDown"),
    computerUseReleaseKeyUp: note("releaseKeyUp"),
    computerUseType: note("type"),
    computerUseWait: note("wait"),
    computerUseCancel: async () => {
      machine.calls.push("cancel");
    },
    computerUseResetCancel: note("resetCancel"),
  } satisfies ComputerUseHost;
  return { tauriComputerUseHost: host };
});

const adapters = vi.hoisted(() => ({
  factory: null as unknown as {
    providerId: string;
    environment: string;
    capabilities: Record<string, unknown>;
    create: () => unknown;
  },
  approval: { answer: "approve" as string },
}));

vi.mock("@maus-inc/voice-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@maus-inc/voice-ai")>();
  return {
    ...actual,
    createComputerUseSessionFactory: () => adapters.factory,
  };
});

vi.mock("./computer-use-approval", () => ({
  computerUseToolId: (action: { type: string }) =>
    `computer_use:${action.type}`,
  requestComputerUseApproval: vi.fn(async () => ({
    answer: adapters.approval.answer,
  })),
}));

vi.mock("../run-agent", () => ({
  // `chat.actions` reaches `abortAgentLoop` through the `src/agents` barrel,
  // which re-exports this module, so the mock must keep the name or the import
  // binds to undefined.
  abortAgentLoop: vi.fn(),
  safeSideEffect: async (_l: string, _c: string, fn: () => unknown) => {
    await fn();
  },
  finalizeAssistantMessage: vi.fn(async () => undefined),
}));

vi.mock("../../repos", () => ({
  getChatMessageRepo: () => ({
    createChatMessage: vi.fn(async () => undefined),
    deleteChatMessages: vi.fn(async () => undefined),
  }),
  getAgentRepo: () => ({ repo: { streamChat: vi.fn() } }),
}));

import { abortAgent } from "../../actions/chat.actions";
import { createDefaultPreferences } from "../../actions/user.actions";
import { produceAppState } from "../../store";
import { runComputerUseForConversation } from "./run-computer-use-for-conversation";

/**
 * A session that asks for a click on every turn, at a different point each
 * time.
 *
 * The varying point matters: an identical action repeated is the stuck
 * detector's own signal, so a session that repeated itself would end the run on
 * its own and the test would pass without Stop doing anything.
 */
const endlessSession = () => {
  let turn = 0;
  const next = () => {
    turn += 1;
    return {
      actions: [
        {
          callId: `call-${turn}`,
          providerName: "scripted",
          action: {
            type: "click" as const,
            x: 400 + (turn % 7) * 13,
            y: 300 + (turn % 5) * 17,
          },
        },
      ],
      text: "",
    };
  };
  return { start: next, advance: next };
};

const clicks = (): number =>
  machine.calls.filter((call) => call === "click").length;

const seedConversation = (conversationId: string, text: string): void => {
  produceAppState((draft) => {
    draft.chatMessageById["user-1"] = {
      id: "user-1",
      conversationId,
      role: "user",
      content: text,
      createdAt: Date.now(),
    } as never;
    draft.chatMessageIdsByConversationId[conversationId] = ["user-1"];
  });
};

/** Start a run, let it get going, press Stop, and report what happened after. */
const stopMidRun = async (conversationId: string, text: string) => {
  seedConversation(conversationId, text);
  // No signal, because production supplies none. A test that passes a
  // controller exercises a route the router never takes.
  const run = runComputerUseForConversation(conversationId, text);
  await new Promise((resolve) => setTimeout(resolve, RUN_FOR_MS));
  const atStop = clicks();
  abortAgent(conversationId);
  await run;
  return { atStop, afterStop: clicks() - atStop, calls: machine.calls };
};

beforeEach(() => {
  machine.calls.length = 0;
  adapters.approval.answer = "approve";
  adapters.factory = {
    providerId: "scripted",
    environment: "desktop",
    capabilities: { supportsComputerUse: true },
    create: endlessSession,
  } as unknown as typeof adapters.factory;
  produceAppState((draft) => {
    draft.userPrefs = createDefaultPreferences();
    draft.chatMessageById = {};
    draft.chatMessageIdsByConversationId = {};
    draft.streamingMessageById = {};
    draft.agentStateByConversationId = {};
    draft.toolPermissionById = {};
    // The loop factory reads agent-mode prefs and refuses without a model, so
    // leaving these unset would make every case here vacuous.
    draft.settings.agentMode = {
      mode: "api",
      selectedApiKeyId: "key-1",
      openclawGatewayUrl: null,
      openclawToken: null,
    };
    draft.apiKeyById = {
      "key-1": {
        id: "key-1",
        name: "test",
        provider: "gemini",
        createdAt: Date.now(),
        keyFull: "secret",
        postProcessingModel: "gemini-3.8-flash",
      },
    } as never;
  });
});

describe("the Stop button on a computer use run", () => {
  it("takes the loop off the machine", async () => {
    const { atStop, afterStop } = await stopMidRun("stop-clicks", "click");
    // The run really was acting, so the next line cannot pass vacuously.
    expect(atStop).toBeGreaterThan(0);
    expect(afterStop).toBe(0);
  });

  it("tells the operating system to release anything it is holding", async () => {
    const { calls } = await stopMidRun("stop-holding", "click");
    // A held key, a held mouse button or a long native wait does not come back
    // because the JavaScript loop stopped looking at it.
    expect(calls).toContain("cancel");
  });

  it("does not ask for another approval once stopped", async () => {
    const { atStop, afterStop } = await stopMidRun("stop-mid-turn", "click");
    expect(atStop).toBeGreaterThan(0);
    expect(afterStop).toBe(0);
  });

  it("stops a run that was refused its approval", async () => {
    adapters.approval.answer = "deny";
    const { atStop, afterStop, calls } = await stopMidRun(
      "stop-denied",
      "click",
    );
    expect(atStop).toBe(0);
    expect(afterStop).toBe(0);
    expect(calls).toContain("cancel");
  });
});
