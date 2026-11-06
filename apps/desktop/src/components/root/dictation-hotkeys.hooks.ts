import { useEffect, useRef } from "react";
import { applyInDictationStyleSwitch } from "../../actions/tone.actions";
import {
  useHotkeyFire,
  useHotkeyFireMany,
  useHotkeyHold,
  useHotkeyHoldMany,
} from "../../hooks/hotkey.hooks";
import { useAppStore } from "../../store";
import type { RecordingMode } from "../../state/app.state";
import type { ActivationController } from "../../utils/activation.utils";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import {
  isActivationComboHeld,
  resolveInDictationArrowStyleSwitch,
  resolveNewlyPressedDictationArrow,
} from "../../utils/dictation-style.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  getHotkeyCombosForAction,
  getSwitchToStyleEntries,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
} from "../../utils/keyboard.utils";

const STYLE_KEYS = ["LeftArrow", "RightArrow"];

const switchStyleForward = () =>
  applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: 1 });
const switchStyleBackward = () =>
  applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: -1 });

/** Own held-key style switching, including the edge-triggered key snapshot. */
function useDictationStyleArrows(
  isMainWindow: boolean,
  mode: RecordingMode | null,
  manual: boolean,
  enabled: boolean,
): void {
  const previousRef = useRef<string[]>([]);
  const keysHeld = useAppStore((state) => state.keysHeld);
  const combos = useAppStore((state) =>
    getHotkeyCombosForAction(state, DICTATE_HOTKEY),
  );
  useEffect(() => {
    const previous = new Set(
      previousRef.current.map((key) => key.toLowerCase()),
    );
    const current = new Set(keysHeld.map((key) => key.toLowerCase()));
    const direction = resolveInDictationArrowStyleSwitch({
      enabled,
      isMainWindow,
      isActiveDictateSession: mode === "dictate",
      isManualStyling: manual,
      activationHeld: isActivationComboHeld(combos, current),
      newlyPressed: resolveNewlyPressedDictationArrow(current, previous),
    });
    if (direction === "forward")
      void applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    else if (direction === "backward")
      void applyInDictationStyleSwitch({ channel: "arrows", direction: -1 });
    previousRef.current = keysHeld;
  }, [keysHeld, mode, manual, enabled, combos, isMainWindow]);
}

/** Availability is calculated once so every recording shortcut agrees on ownership. */
function recordingShortcutAvailability(
  isMainWindow: boolean,
  interactable: boolean,
  mode: RecordingMode | null,
  assistantEnabled: boolean,
) {
  const unavailable = !isMainWindow || !interactable;
  return {
    dictateDisabled: unavailable || mode === "agent",
    agentDisabled: unavailable || !assistantEnabled || mode === "dictate",
    cancelDisabled: !isMainWindow || mode === null,
  };
}

function styleShortcutAvailability(
  isMainWindow: boolean,
  unlocked: boolean,
  mode: RecordingMode | null,
  manual: boolean,
  enabled: boolean,
) {
  return {
    directDisabled: !isMainWindow || !unlocked,
    cycleDisabled: !isMainWindow || mode === null || !manual,
    allowedAdditionalKeys:
      enabled && manual && mode === "dictate" ? STYLE_KEYS : undefined,
  };
}

/** Register dictation and style shortcuts against their shared activation owners. */
export function useDictationHotkeys({
  isMainWindow,
  isDictationInteractable,
  isDictationUnlocked,
  dictationController,
  agentController,
  additionalLanguageControllers,
  promptCancelTranscription,
}: {
  isMainWindow: boolean;
  isDictationInteractable: boolean;
  isDictationUnlocked: boolean;
  dictationController: ActivationController;
  agentController: ActivationController;
  additionalLanguageControllers: {
    actionName: string;
    controller: ActivationController;
  }[];
  promptCancelTranscription: () => void;
}): void {
  const mode = useAppStore((state) => state.activeRecordingMode);
  const manual = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );
  const enabled = useAppStore(
    (state) => state.userPrefs?.inDictationStyleSwitchingEnabled ?? false,
  );
  const assistantEnabled = useAppStore(getIsAssistantModeEnabled);
  const styles = useAppStore(getSwitchToStyleEntries);
  const recording = recordingShortcutAvailability(
    isMainWindow,
    isDictationInteractable,
    mode,
    assistantEnabled,
  );
  const style = styleShortcutAvailability(
    isMainWindow,
    isDictationUnlocked,
    mode,
    manual,
    enabled,
  );
  useDictationStyleArrows(isMainWindow, mode, manual, enabled);
  useHotkeyFireMany({
    actions: styles.map((entry) => ({
      actionName: entry.actionName,
      onFire: () => {
        void applyInDictationStyleSwitch({
          channel: "hotkey",
          toneId: entry.toneId,
        });
      },
    })),
    isDisabled: style.directDisabled,
  });
  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    isDisabled: style.cycleDisabled,
    onFire: switchStyleForward,
  });
  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    isDisabled: style.cycleDisabled,
    onFire: switchStyleBackward,
  });
  useHotkeyHold({
    actionName: DICTATE_HOTKEY,
    isDisabled: recording.dictateDisabled,
    controller: dictationController,
    allowedAdditionalKeys: style.allowedAdditionalKeys,
  });
  useHotkeyHold({
    actionName: AGENT_DICTATE_HOTKEY,
    isDisabled: recording.agentDisabled,
    controller: agentController,
  });
  useHotkeyFire({
    actionName: CANCEL_TRANSCRIPTION_HOTKEY,
    isDisabled: recording.cancelDisabled,
    onFire: promptCancelTranscription,
  });
  useHotkeyHoldMany({
    isDisabled: recording.dictateDisabled,
    actions: additionalLanguageControllers,
  });
}
