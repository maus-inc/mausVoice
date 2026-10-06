import type { ApiKey, ChatMessage } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPreferences } from "../../actions/user.actions";
import { produceAppState } from "../../store";

// `vi.mock` factories are hoisted above module-level `const`, so the doubles
// have to be hoisted with them or the factory throws on first use.
const {
  runAgent,
  runComputerUseForConversation,
  isComputerUseRunning,
  supportsComputerUse,
  createChatMessage,
} = vi.hoisted(() => ({
  runAgent: vi.fn(async () => {}),
  runComputerUseForConversation: vi.fn(async () => {}),
  isComputerUseRunning: vi.fn(() => false),
  supportsComputerUse: vi.fn(() => true),
  createChatMessage: vi.fn(async (message: ChatMessage) => message),
}));

vi.mock("../../agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents")>()),
  runAgent,
}));
vi.mock("./run-computer-use-for-conversation", () => ({
  runComputerUseForConversation,
}));
vi.mock("./run-computer-use", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isComputerUseRunning,
}));
vi.mock("@maus-inc/voice-ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supportsComputerUse,
}));
vi.mock("../../actions/chat.actions", () => ({ createChatMessage }));

import { runAgentForSend } from "./route-agent-run";

const CONVERSATION_ID = "conversation-1";

const addUserMessage = (
  content: string,
  role: "user" | "assistant" = "user",
) => {
  const id = `message-${content}`;
  produceAppState((draft) => {
    draft.chatMessageById[id] = {
      id,
      conversationId: CONVERSATION_ID,
      role,
      content,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: null,
    };
    const ids = draft.chatMessageIdsByConversationId[CONVERSATION_ID] ?? [];
    draft.chatMessageIdsByConversationId[CONVERSATION_ID] = [...ids, id];
  });
};

/**
 * `getAgentModePrefs` reads `settings.agentMode` plus `apiKeyById`, not
 * `userPrefs`. Setting the wrong one leaves the run in the "needs an API model"
 * branch, which is a green test for the wrong reason.
 */
const useAgentModel = (provider: ApiKey["provider"]) => {
  produceAppState((draft) => {
    draft.settings.agentMode = {
      ...draft.settings.agentMode,
      mode: "api",
      selectedApiKeyId: "key-1",
    };
    draft.apiKeyById["key-1"] = {
      id: "key-1",
      name: "Test key",
      provider,
      createdAt: "2026-01-01T00:00:00.000Z",
      keyFull: "test-key",
      postProcessingModel: "test-model",
    };
  });
};

const setComputerUseEnabled = (enabled: boolean) => {
  produceAppState((draft) => {
    draft.local.computerUseEnabled = enabled;
  });
};

describe("runAgentForSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isComputerUseRunning.mockReturnValue(false);
    supportsComputerUse.mockReturnValue(true);
    produceAppState((draft) => {
      draft.chatMessageById = {};
      draft.chatMessageIdsByConversationId = {};
      draft.apiKeyById = {};
      draft.userPrefs = createDefaultPreferences();
      draft.settings.agentMode = {
        ...draft.settings.agentMode,
        mode: null,
        selectedApiKeyId: null,
      };
      draft.local.computerUseEnabled = false;
    });
  });

  it("uses the chat run when computer use is off", async () => {
    useAgentModel("gemini");
    addUserMessage("what is on my screen?");

    await runAgentForSend(CONVERSATION_ID);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runComputerUseForConversation).not.toHaveBeenCalled();
  });

  it("uses the computer-use run when the toggle is on and the model can drive a screen", async () => {
    useAgentModel("gemini");
    setComputerUseEnabled(true);
    addUserMessage("open the file manager");

    await runAgentForSend(CONVERSATION_ID);

    expect(runComputerUseForConversation).toHaveBeenCalledWith(
      CONVERSATION_ID,
      "open the file manager",
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("acts on the last user message rather than the whole conversation", async () => {
    useAgentModel("gemini");
    setComputerUseEnabled(true);
    addUserMessage("first request");
    addUserMessage("an answer", "assistant");
    addUserMessage("second request");

    await runAgentForSend(CONVERSATION_ID);

    expect(runComputerUseForConversation).toHaveBeenCalledWith(
      CONVERSATION_ID,
      "second request",
    );
  });

  it("reports why and falls back to chat when the model cannot drive a screen", async () => {
    useAgentModel("ollama");
    supportsComputerUse.mockReturnValue(false);
    setComputerUseEnabled(true);
    addUserMessage("open the file manager");

    await runAgentForSend(CONVERSATION_ID);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runComputerUseForConversation).not.toHaveBeenCalled();
    expect(createChatMessage).toHaveBeenCalledTimes(1);
    const reported = createChatMessage.mock.calls[0][0];
    expect(reported.role).toBe("assistant");
    expect(reported.content).toContain("ollama");
  });

  it("reports why and falls back to chat when no API model is selected", async () => {
    setComputerUseEnabled(true);
    addUserMessage("open the file manager");

    await runAgentForSend(CONVERSATION_ID);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runComputerUseForConversation).not.toHaveBeenCalled();
    expect(createChatMessage).toHaveBeenCalledTimes(1);
  });

  it("says nothing about computer use when the toggle is off, even for a model that cannot drive a screen", async () => {
    useAgentModel("ollama");
    supportsComputerUse.mockReturnValue(false);
    addUserMessage("open the file manager");

    await runAgentForSend(CONVERSATION_ID);

    expect(createChatMessage).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("falls back to chat rather than starting a run with no goal", async () => {
    useAgentModel("gemini");
    setComputerUseEnabled(true);

    await runAgentForSend(CONVERSATION_ID);

    expect(runComputerUseForConversation).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("treats a whitespace-only request as no request", async () => {
    useAgentModel("gemini");
    setComputerUseEnabled(true);
    addUserMessage("   ");

    await runAgentForSend(CONVERSATION_ID);

    expect(runComputerUseForConversation).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not start a second computer-use run while one is live", async () => {
    useAgentModel("gemini");
    setComputerUseEnabled(true);
    isComputerUseRunning.mockReturnValue(true);
    addUserMessage("open the file manager");

    await runAgentForSend(CONVERSATION_ID);

    expect(runComputerUseForConversation).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
