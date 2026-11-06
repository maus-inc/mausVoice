import { applyInDictationStyleSwitch } from "../../actions/tone.actions";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { getAppState } from "../../store";
import type { OverlayResolvePermissionPayload } from "../../types/overlay.types";
import {
  debouncedToggle,
  type ActivationController,
} from "../../utils/activation.utils";
import { getLogger } from "../../utils/log.utils";
import { resolvePillBodyClickIntent } from "../../utils/pill-click.utils";
import type { NativeRecordingLeaseRef } from "./dictation-recording-intake";

const observeAction = (action: Promise<void>, label: string): void => {
  action.catch((error: unknown) =>
    getLogger().error(`Failed to ${label}: ${error}`),
  );
};

/** Route native pill intents to the one main-window recording owner. */
export function useDictationPillEvents({
  isMainWindow,
  isDictationInteractable,
  isPausedRef,
  isStoppingRef,
  nativeStartOwnerRef,
  abortRecording,
  pauseDictation,
  resumeDictation,
  dictationController,
  agentController,
}: {
  isMainWindow: boolean;
  isDictationInteractable: boolean;
  isPausedRef: { current: boolean };
  isStoppingRef: { current: boolean };
  nativeStartOwnerRef: NativeRecordingLeaseRef;
  abortRecording: () => Promise<void>;
  pauseDictation: () => Promise<void>;
  resumeDictation: () => Promise<void>;
  dictationController: ActivationController;
  agentController: ActivationController;
}): void {
  useTauriListen<void>("cancel-dictation", () => {
    if (isMainWindow) observeAction(abortRecording(), "cancel dictation");
  });
  useTauriListen<void>("pause-dictation", () => {
    if (isMainWindow) observeAction(pauseDictation(), "pause dictation");
  });
  useTauriListen<void>("resume-dictation", () => {
    if (isMainWindow) observeAction(resumeDictation(), "resume dictation");
  });
  useToastAction(async (payload) => {
    if (!isMainWindow) return;
    if (payload.action === "confirm_cancel_transcription") {
      await abortRecording();
    } else if (
      payload.action === "cancel_recording_stop" &&
      isStoppingRef.current &&
      payload.proposalId !== undefined &&
      payload.proposalId === nativeStartOwnerRef.current?.ownerId
    ) {
      await abortRecording();
    }
  });
  useTauriListen<void>("on-click-dictate", () => {
    const intent = resolvePillBodyClickIntent({
      isMainWindow,
      isDictationInteractable,
      isPaused: isPausedRef.current,
    });
    if (intent === "resume")
      observeAction(resumeDictation(), "resume dictation");
    else if (intent === "toggle")
      debouncedToggle("dictation", dictationController);
  });
  useTauriListen<void>("on-click-agent-talk", () => {
    if (isMainWindow && isDictationInteractable)
      debouncedToggle("agent", agentController);
  });
  useTauriListen<void>("tone-switch-forward", () => {
    if (isMainWindow)
      void applyInDictationStyleSwitch({ channel: "pill", direction: 1 });
  });
  useTauriListen<void>("tone-switch-backward", () => {
    if (isMainWindow)
      void applyInDictationStyleSwitch({ channel: "pill", direction: -1 });
  });
  useTauriListen<OverlayResolvePermissionPayload>(
    "overlay-resolve-permission",
    (payload) => {
      if (!isMainWindow) return;
      if (payload.alwaysAllow) {
        const permission =
          getAppState().toolPermissionById[payload.permissionId];
        if (permission)
          setToolAlwaysAllow({
            toolId: permission.toolId,
            params: permission.params,
            allowed: true,
            scope: `conversation:${permission.conversationId}`,
          });
      }
      resolveToolPermission(payload.permissionId, payload.status);
    },
  );
}
