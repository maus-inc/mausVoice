import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useAppStore } from "../../store";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { resolvePillWindowSize } from "../../utils/pill-window-size.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
} from "../../utils/tone.utils";
import { getEffectivePillVisibility } from "../../utils/user.utils";

/** Synchronize the native pill's presentation from the main window only. */
export function usePillPresentationSync(isMainWindow: boolean): void {
  const visibility = useAppStore((state) =>
    getEffectivePillVisibility(state.userPrefs?.dictationPillVisibility),
  );
  const activeRecordingMode = useAppStore((state) => state.activeRecordingMode);
  const assistantInputMode = useAppStore((state) => state.assistantInputMode);
  const hasPendingReview = useAppStore(
    (state) => state.pendingPillReview !== null,
  );
  const pillHasContent = useAppStore((state) => {
    if (!state.pillConversationId) return false;
    const ids =
      state.chatMessageIdsByConversationId[state.pillConversationId] ?? [];
    if (ids.length > 0) return true;
    return Object.values(state.toolPermissionById).some(
      (permission) =>
        permission.conversationId === state.pillConversationId &&
        permission.status === "pending",
    );
  });
  const styleCount = useAppStore((state) =>
    getEffectiveStylingMode(state) === "manual"
      ? getActiveManualToneIds(state).length
      : 0,
  );
  const styleName = useAppStore(
    (state) =>
      getToneById(state, getManuallySelectedToneId(state))?.name ?? "-",
  );

  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_pill_visibility", { visibility }).catch(console.error);
  }, [isMainWindow, visibility]);
  useEffect(() => {
    if (!isMainWindow) return;
    const size = resolvePillWindowSize({
      hasPendingReview,
      isAgentRecording: activeRecordingMode === "agent",
      isAssistantTyping: assistantInputMode === "type",
      pillHasContent,
    });
    invoke("set_pill_window_size", { size }).catch(console.error);
  }, [
    isMainWindow,
    activeRecordingMode,
    assistantInputMode,
    hasPendingReview,
    pillHasContent,
  ]);
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("notify_pill_style_info", {
      count: styleCount,
      name: styleName,
    }).catch(console.error);
  }, [isMainWindow, styleCount, styleName]);
}
