import { supportsComputerUse } from "@maus-inc/voice-ai";
import { createChatMessage } from "../../actions/chat.actions";
import { getAppState } from "../../store";
import { getIsComputerUseEnabled } from "../../utils/assistant-mode.utils";
import { logOnRejection } from "../../utils/promise.utils";
import { getLogger } from "../../utils/log.utils";
import { getAgentModePrefs } from "../../utils/user.utils";
// Through the barrel, not the module. `chat.actions` imports this file, and its
// test mocks the barrel; a direct `../run-agent` import would pull the real
// module in and reach the unmocked LLM repo.
import { CHAT_AGENT_CONFIG, runAgent } from "../../agents";
import { isComputerUseRunning } from "./run-computer-use";
import { runComputerUseForConversation } from "./run-computer-use-for-conversation";

const log = getLogger();

/**
 * The last thing the user said in this conversation, which is what a
 * computer-use turn acts on.
 *
 * A computer-use turn acts on the immediate request, not on the whole
 * transcript. Replaying the history into the goal would ask the model to redo
 * work the conversation has already finished, which is how "tidy my desktop"
 * turns into a loop over every earlier message.
 *
 * `null` when there is nothing to act on, which happens on a resend whose user
 * message was deleted. The caller falls back to the chat run rather than
 * starting a run with no goal.
 */
const lastUserRequest = (conversationId: string): string | null => {
  const state = getAppState();
  const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const message = state.chatMessageById[ids[i]];
    if (message?.role === "user") {
      const content = message.content.trim();
      return content.length > 0 ? content : null;
    }
  }
  return null;
};

/**
 * Why computer use cannot run right now, or `null` when it can.
 *
 * The answer comes from the adapter registry rather than a provider name, so
 * registering another provider makes this true without a change here.
 */
const computerUseUnavailableReason = (): string | null => {
  const prefs = getAgentModePrefs(getAppState());
  if (prefs.mode !== "api") {
    return "Computer use needs an API model selected in assistant mode.";
  }
  if (!supportsComputerUse(prefs.provider)) {
    return `${prefs.provider} cannot control the screen. Pick a model with computer use in the API key settings.`;
  }
  return null;
};

/**
 * Tell the user once why their send went to chat instead of the screen.
 *
 * Without this the toggle looks broken: they turned it on, asked for something
 * visual, and got a chat answer with no explanation.
 *
 * It is a persisted assistant message rather than run state because a run
 * state carrying `error` reads as the send having failed, and nothing failed.
 * The write is fire-and-forget: a message the user cannot see is not worth
 * failing a send that is about to succeed.
 */
const reportComputerUseUnavailable = (
  conversationId: string,
  reason: string,
): void => {
  log.verbose("Computer use is unavailable; using the chat run", {
    conversationId,
    reason,
  });
  logOnRejection(
    createChatMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: reason,
      createdAt: new Date().toISOString(),
      metadata: null,
    }),
    "computer use: report unavailable",
  );
};

/**
 * Run whichever agent loop this conversation's send calls for.
 *
 * Computer use replaces the tool-calling run rather than running beside it. A
 * conversation has one run at a time, and two loops writing the same streaming
 * message state would interleave their turns into one bubble.
 */
export const runAgentForSend = async (
  conversationId: string,
): Promise<void> => {
  if (
    getIsComputerUseEnabled(getAppState()) &&
    !isComputerUseRunning(conversationId)
  ) {
    const goal = lastUserRequest(conversationId);
    if (goal !== null) {
      const reason = computerUseUnavailableReason();
      if (reason === null) {
        log.verbose("Routing this send to the computer-use loop", {
          conversationId,
        });
        await runComputerUseForConversation(conversationId, goal);
        return;
      }
      reportComputerUseUnavailable(conversationId, reason);
    }
  }
  await runAgent(conversationId, CHAT_AGENT_CONFIG);
};
