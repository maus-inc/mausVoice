import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleTranscriptParams } from "../types/strategy.types";
import { AgentStrategy } from "./agent.strategy";

const mocks = vi.hoisted(() => ({
  enabled: false,
  state: {
    userPrefs: { hallucinationFilterEnabled: true },
    pillConversationId: null as string | null,
  },
  invoke: vi.fn(),
  createConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  showToast: vi.fn(),
  filter: vi.fn((text: string) => text),
  stage: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../actions/chat.actions", () => ({
  createConversation: mocks.createConversation,
  sendChatMessage: mocks.sendChatMessage,
}));
vi.mock("../actions/toast.actions", async () => ({
  showToast: mocks.showToast,
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
}));
vi.mock("../i18n", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (fn: (draft: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../utils/assistant-mode.utils", () => ({
  getIsAssistantModeEnabled: () => mocks.enabled,
}));
vi.mock("../utils/id.utils", () => ({ createId: () => "new-id" }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), verbose: vi.fn(), error: vi.fn() }),
}));
vi.mock("../utils/overlay.utils", () => ({ sendPillStageText: mocks.stage }));
vi.mock("../utils/string.utils", () => ({
  filterKnownSilenceHallucinations: mocks.filter,
}));
vi.mock("../utils/user.utils", () => ({ getMyDictationLanguage: () => "en" }));

const transcript = (rawTranscript: string) =>
  ({ rawTranscript }) as HandleTranscriptParams;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = false;
  mocks.state.userPrefs.hallucinationFilterEnabled = true;
  mocks.state.pillConversationId = null;
  mocks.invoke.mockResolvedValue(undefined);
  mocks.createConversation.mockResolvedValue({ id: "conversation-1" });
  mocks.sendChatMessage.mockResolvedValue(undefined);
  mocks.showToast.mockResolvedValue(undefined);
  mocks.filter.mockImplementation((text: string) => text);
});

describe("AgentStrategy", () => {
  it("requires assistant mode and never stores the dictated transcript", () => {
    const strategy = new AgentStrategy();
    expect(strategy.validateAvailability()).toMatchObject({
      action: "open_agent_settings",
    });
    expect(strategy.shouldStoreTranscript()).toBe(false);
    mocks.enabled = true;
    expect(strategy.validateAvailability()).toBeNull();
  });

  it("creates one conversation per session and clears it on cleanup", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    await strategy.onBeforeStart();
    expect(mocks.createConversation).toHaveBeenCalledOnce();
    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-id", title: "New conversation" }),
    );
    expect(mocks.state.pillConversationId).toBe("conversation-1");
    await strategy.cleanup();
    expect(mocks.state.pillConversationId).toBeNull();
    await strategy.onBeforeStart();
    expect(mocks.createConversation).toHaveBeenCalledTimes(2);
  });

  it("retires its own conversation without clearing a successor's pill", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.state.pillConversationId = "successor";
    await strategy.cleanup(() => false);
    expect(mocks.state.pillConversationId).toBe("successor");
    await strategy.handleTranscript(transcript("old words"));
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("bounds a stalled conversation creation and ignores its late reply", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (conversation: { id: string }) => void;
      mocks.createConversation.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const strategy = new AgentStrategy();
      const start = strategy.onBeforeStart();
      const failure = expect(start).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await failure;
      finish({ id: "late" });
      await Promise.resolve();
      expect(mocks.state.pillConversationId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore a conversation after its recording is retired", async () => {
    let finish!: (conversation: { id: string }) => void;
    mocks.createConversation.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const strategy = new AgentStrategy();
    const start = strategy.onBeforeStart();
    await strategy.cleanup();
    finish({ id: "retired" });
    await start;
    expect(mocks.state.pillConversationId).toBeNull();
    await strategy.handleTranscript(transcript("private"));
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("does not send dictated text if updating the pill retires its recording", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.stage.mockImplementationOnce(() => {
      void strategy.cleanup();
    });
    const result = await strategy.handleTranscript(transcript("private"));
    expect(result.shouldContinue).toBe(false);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("ignores a late chat error from a retired recording", async () => {
    let reject!: (error: Error) => void;
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.sendChatMessage.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    let current = true;
    const result = strategy.handleTranscript({
      ...transcript("hello"),
      isCurrent: () => current,
    });
    current = false;
    reject(new Error("old failure"));
    expect((await result).shouldContinue).toBe(false);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("passes overlay phases to the native command", async () => {
    const strategy = new AgentStrategy();
    await strategy.setPhase("recording");
    expect(mocks.invoke).toHaveBeenCalledWith("set_phase", {
      phase: "recording",
    });
  });

  it("does not send a message before a conversation exists or when filtering removes it", async () => {
    const strategy = new AgentStrategy();
    expect(
      (await strategy.handleTranscript(transcript("hello"))).shouldContinue,
    ).toBe(false);
    await strategy.onBeforeStart();
    mocks.filter.mockReturnValueOnce("  ");
    expect(
      (await strategy.handleTranscript(transcript("silence"))).shouldContinue,
    ).toBe(false);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("sends filtered text and honors the preference to disable filtering", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.filter.mockReturnValueOnce("filtered");
    expect(
      (await strategy.handleTranscript(transcript("original"))).shouldContinue,
    ).toBe(true);
    expect(mocks.filter).toHaveBeenCalledWith("original", "en");
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "conversation-1",
      "filtered",
      undefined,
      expect.any(Function),
    );
    expect(mocks.stage).toHaveBeenCalledWith(null);
    mocks.state.userPrefs.hallucinationFilterEnabled = false;
    await strategy.handleTranscript(transcript("unfiltered"));
    expect(mocks.sendChatMessage).toHaveBeenLastCalledWith(
      "conversation-1",
      "unfiltered",
      undefined,
      expect.any(Function),
    );
    expect(mocks.filter).toHaveBeenCalledOnce();
  });

  it("does not hold a failed chat send open for a stalled toast", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.sendChatMessage.mockRejectedValueOnce(new Error("provider error"));
    mocks.showToast.mockReturnValueOnce(new Promise(() => {}));
    const result = await Promise.race([
      strategy.handleTranscript(transcript("hello")),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 100),
      ),
    ]);
    expect(result).not.toBe("stalled");
    expect(result).toMatchObject({ shouldContinue: true });
  });

  it("shows a failure toast without terminating the recording flow", async () => {
    const strategy = new AgentStrategy();
    await strategy.onBeforeStart();
    mocks.sendChatMessage.mockRejectedValueOnce(new Error("provider error"));
    expect(
      (await strategy.handleTranscript(transcript("hello"))).shouldContinue,
    ).toBe(true);
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Chat request failed",
        toastType: "error",
      }),
    );
  });
});
