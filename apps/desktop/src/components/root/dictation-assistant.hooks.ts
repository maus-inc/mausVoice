import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import {
  createConversation,
  loadChatMessages,
  sendChatMessage,
} from "../../actions/chat.actions";
import { useHotkeyFire } from "../../hooks/hotkey.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { getBrowserRouter } from "../../router";
import { getAppState, produceAppState } from "../../store";
import { createId } from "../../utils/id.utils";
import { OPEN_CHAT_HOTKEY } from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import { surfaceMainWindow } from "../../utils/window.utils";

const reportConversationOpenFailure = (error: unknown): void => {
  getLogger().warning(
    `Failed to open the conversation: ${error instanceof Error ? error.message : String(error)}`,
  );
};

/** Own the pill assistant's typed messages, conversation navigation and lifecycle events. */
export function useDictationAssistant({
  isMainWindow,
  abortRecording,
  enterTypeMode,
  recordingOperationRef,
}: {
  isMainWindow: boolean;
  abortRecording: () => Promise<void>;
  enterTypeMode: () => void;
  recordingOperationRef: { current: number };
}): void {
  const intl = useIntl();
  const pendingConversationRef = useRef<{
    operation: number;
    promise: Promise<string | null>;
  } | null>(null);
  const getConversation = useCallback(
    async (operation: number): Promise<string | null> => {
      const existing = getAppState().pillConversationId;
      if (existing) return existing;
      if (pendingConversationRef.current?.operation === operation)
        return pendingConversationRef.current.promise;
      const now = new Date().toISOString();
      const pending = createConversation({
        id: createId(),
        title: intl.formatMessage({ defaultMessage: "New conversation" }),
        createdAt: now,
        updatedAt: now,
      }).then((conversation) => {
        if (recordingOperationRef.current !== operation) return null;
        const selected = getAppState().pillConversationId;
        if (selected) return selected;
        produceAppState((draft) => {
          draft.pillConversationId = conversation.id;
        });
        return conversation.id;
      });
      pendingConversationRef.current = { operation, promise: pending };
      try {
        return await pending;
      } finally {
        if (pendingConversationRef.current?.promise === pending)
          pendingConversationRef.current = null;
      }
    },
    [intl, recordingOperationRef],
  );

  const openPillConversation = useCallback(
    async (conversationId?: string) => {
      const operation = recordingOperationRef.current;
      const id = conversationId ?? getAppState().pillConversationId;
      if (id) {
        void loadChatMessages(id).catch(reportConversationOpenFailure);
        await getBrowserRouter()
          .navigate(`/dashboard/chats?id=${encodeURIComponent(id)}`)
          .catch((error: unknown) => {
            getLogger().warning(
              `Failed to navigate to the conversation: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      await surfaceMainWindow();
      // Navigation and window activation can finish after a new recording has
      // started. Opening an older conversation must not cancel its successor.
      if (recordingOperationRef.current === operation) await abortRecording();
    },
    [abortRecording, recordingOperationRef],
  );

  useTauriListen<void>("assistant-mode-close", async () => {
    if (isMainWindow) await abortRecording();
  });
  useTauriListen<void>("assistant-enable-type-mode", () => {
    if (isMainWindow) enterTypeMode();
  });
  useTauriListen<{ text: string }>(
    "assistant-typed-message",
    async ({ text }) => {
      if (!isMainWindow || !text.trim()) return;
      const operation = recordingOperationRef.current;
      const id = await getConversation(operation);
      if (!id || recordingOperationRef.current !== operation) return;
      getLogger().info(`Sending typed message (${text.length} chars)`);
      sendChatMessage(id, text).catch((error) =>
        getLogger().error(`Failed to send typed message: ${error}`),
      );
    },
  );
  useTauriListen<{ conversationId: string }>(
    "open-pill-conversation",
    ({ conversationId }) => {
      if (isMainWindow)
        void openPillConversation(conversationId).catch(
          reportConversationOpenFailure,
        );
    },
  );
  useHotkeyFire({
    actionName: OPEN_CHAT_HOTKEY,
    isDisabled: !isMainWindow,
    onFire: () => {
      void openPillConversation().catch(reportConversationOpenFailure);
    },
  });
}
