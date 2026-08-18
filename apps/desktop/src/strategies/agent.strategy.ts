import type { Nullable } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { createConversation, sendChatMessage } from "../actions/chat.actions";
import { showToast } from "../actions/toast.actions";
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
import { filterKnownSilenceHallucinations } from "../utils/string.utils";
import { getMyDictationLanguage } from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

export class AgentStrategy extends BaseStrategy {
  private conversationId: string | null = null;

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

  async onBeforeStart(): Promise<void> {
    if (!this.conversationId) {
      const now = new Date().toISOString();
      const conversation = await createConversation({
        id: createId(),
        title: getIntl().formatMessage({
          defaultMessage: "New conversation",
        }),
        createdAt: now,
        updatedAt: now,
      });
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
  }: HandleTranscriptParams): Promise<HandleTranscriptResult> {
    if (!this.conversationId) {
      return {
        shouldContinue: false,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    }

    try {
      const sanitizedTranscript =
        getAppState().userPrefs?.hallucinationFilterEnabled === false
          ? rawTranscript
          : filterKnownSilenceHallucinations(
              rawTranscript,
              getMyDictationLanguage(getAppState()),
            );
      getLogger().info(
        `Sending chat message (${sanitizedTranscript.length} chars)`,
      );
      await sendChatMessage(this.conversationId, sanitizedTranscript);

      return {
        shouldContinue: true,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    } catch (error) {
      getLogger().error(`Chat message failed: ${error}`);
      await showToast({
        message: getIntl().formatMessage({
          defaultMessage: "Chat request failed",
        }),
        toastType: "error",
      });
      return {
        shouldContinue: true,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    }
  }

  async cleanup(): Promise<void> {
    getLogger().verbose("Cleaning up agent strategy");
    this.conversationId = null;
    produceAppState((draft) => {
      draft.pillConversationId = null;
    });
  }
}
