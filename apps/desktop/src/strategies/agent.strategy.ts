import type { Nullable } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { createConversation, sendChatMessage } from "../actions/chat.actions";
import { runToast, showToast } from "../actions/toast.actions";
import { getIntl } from "../i18n";
import { getAppState, produceAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";
import { getIsAssistantModeEnabled } from "../utils/assistant-mode.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { sendPillStageText } from "../utils/overlay.utils";
import { filterKnownSilenceHallucinations } from "../utils/string.utils";
import { withTimeout } from "../utils/timeout.utils";
import { getMyDictationLanguage } from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

const agentTranscriptResult = (
  shouldContinue: boolean,
): HandleTranscriptResult => ({
  shouldContinue,
  transcript: null,
  sanitizedTranscript: null,
  postProcessMetadata: {},
  postProcessWarnings: [],
});

/**
 * The dictation language decides which silence hallucinations to strip, and the
 * user can turn the filter off, in which case the transcript goes through as-is.
 */
const sanitizeTranscriptForChat = (rawTranscript: string): string => {
  const state = getAppState();
  if (state.userPrefs?.hallucinationFilterEnabled === false)
    return rawTranscript;
  return filterKnownSilenceHallucinations(
    rawTranscript,
    getMyDictationLanguage(state),
  );
};

/** Tell the user the chat request failed, if this recording still owns the pill. */
const reportChatFailure = (isCurrent: () => boolean): boolean => {
  const message = getIntl().formatMessage({
    defaultMessage: "Chat request failed",
  });
  if (!isCurrent()) return false;
  try {
    runToast(showToast({ message, toastType: "error", isCurrent }));
  } catch {
    getLogger().error("Could not request the chat failure toast");
  }
  return isCurrent();
};

export class AgentStrategy extends BaseStrategy {
  private conversationId: string | null = null;
  private generation = 0;

  shouldStoreTranscript(): boolean {
    return false;
  }

  validateAvailability(): Nullable<StrategyValidationError> {
    const state = getAppState();

    if (!getIsAssistantModeEnabled(state)) {
      return {
        title: getIntl().formatMessage({
          defaultMessage: "Agent mode disabled",
        }),
        body: getIntl().formatMessage({
          defaultMessage: "Enable agent mode in settings to use this feature.",
        }),
        action: "open_agent_settings",
      };
    }

    // The mausVoice Cloud word-limit check was removed with the cloud
    // offering in 0.1.6.
    return null;
  }

  async onBeforeStart(isCurrent: () => boolean = () => true): Promise<void> {
    const generation = this.generation;
    if (isCurrent() && !this.conversationId) {
      const now = new Date().toISOString();
      const conversation = await withTimeout(
        createConversation({
          id: createId(),
          title: getIntl().formatMessage({
            defaultMessage: "New conversation",
          }),
          createdAt: now,
          updatedAt: now,
        }),
        5_000,
        "Conversation creation",
      );
      if (!isCurrent() || this.generation !== generation) return;
      this.conversationId = conversation.id;
      produceAppState((draft) => {
        draft.pillConversationId = conversation.id;
      });
    }
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    await invoke<void>("set_phase", { phase });
  }

  async handleTranscript({
    rawTranscript,
    isCurrent: callerIsCurrent = () => true,
  }: HandleTranscriptParams): Promise<HandleTranscriptResult> {
    const generation = this.generation;
    const isCurrent = () => this.generation === generation && callerIsCurrent();
    const conversationId = this.conversationId;
    if (!isCurrent() || !conversationId) return agentTranscriptResult(false);

    try {
      const sanitizedTranscript = sanitizeTranscriptForChat(rawTranscript);
      if (!sanitizedTranscript.trim()) {
        getLogger().info(
          "Skipping empty chat message after hallucination filtering",
        );
        return agentTranscriptResult(false);
      }
      getLogger().info(
        `Sending chat message (${sanitizedTranscript.length} chars)`,
      );
      sendPillStageText(null);
      if (!isCurrent() || this.conversationId !== conversationId)
        return agentTranscriptResult(false);
      await sendChatMessage(
        conversationId,
        sanitizedTranscript,
        undefined,
        isCurrent,
      );

      return agentTranscriptResult(isCurrent());
    } catch {
      if (!isCurrent()) return agentTranscriptResult(false);
      getLogger().error("Chat message failed");
      return agentTranscriptResult(reportChatFailure(isCurrent));
    }
  }

  async cleanup(isCurrent: () => boolean = () => true): Promise<void> {
    getLogger().verbose("Cleaning up agent strategy");
    this.generation++;
    this.conversationId = null;
    if (isCurrent()) {
      produceAppState((draft) => {
        draft.pillConversationId = null;
      });
    }
  }
}
