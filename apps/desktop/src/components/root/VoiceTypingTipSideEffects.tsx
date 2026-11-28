import { commands } from "@maus-inc/desktop-native-apis";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import {
  acceptVoiceTypingTip,
  declineVoiceTypingTipWithNoThanks,
  dismissVoiceTypingTip,
  getVisibleVoiceTypingTipPromptId,
  registerVoiceTypingTipCooldownListener,
  resetVoiceTypingTipSessionState,
  showVoiceTypingTipPrompt,
} from "../../actions/voice-typing-tip.actions";
import { useToastAction } from "../../hooks/toast.hooks";
import { getAppState, useAppStore } from "../../store";
import { globalKeyStreamIsLive } from "../../utils/keyboard.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
} from "../../utils/user.utils";
import {
  SustainedTypingDetector,
  classifyWebviewActiveElement,
  collectConfiguredHotkeyCombos,
  getVoiceTypingTipExclusionReason,
  shouldClearVisibleVoiceTypingTip,
} from "../../utils/voice-typing-tip";
import { htmlCodeToRdevLabel } from "./KeyPressSideEffects";

const isTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  const win = window as typeof window & Record<string, unknown>;
  return (
    "__TAURI_INTERNALS__" in win || "__TAURI__" in win || "__TAURI_IPC__" in win
  );
};

const isEligibleHostWindow = (): boolean => {
  if (!isTauriRuntime()) {
    return true;
  }
  try {
    const label = getCurrentWindow().label;
    return !label || label === "main" || label === "preview";
  } catch {
    return true;
  }
};

const isMainWindowCurrentlyVisible = async (): Promise<boolean> => {
  if (!isTauriRuntime()) {
    return typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden";
  }
  try {
    return await getCurrentWindow().isVisible();
  } catch {
    return typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden";
  }
};

const isFocusedWebviewEligible = async (): Promise<boolean> => {
  // Capture the focused element up front: the IPC round trip below is async,
  // and a focus change during it must not act on a stale verdict.
  const activeElement = document.activeElement;
  if (classifyWebviewActiveElement(activeElement) !== "eligible") {
    return false;
  }
  if (!isTauriRuntime()) {
    return true;
  }
  const nativeResult = await commands.checkTypingTipTargetEligibility();
  if (nativeResult.status !== "ok") {
    // Fail closed when the OS probe itself fails. A successful `unknown`
    // answer stays non-blocking: the renderer already proved editability
    // for our own webview, and some platforms cannot classify webview
    // content natively at all.
    return false;
  }
  if (
    nativeResult.data === "secure_input" ||
    nativeResult.data === "private_context"
  ) {
    return false;
  }
  return (
    document.activeElement === activeElement &&
    classifyWebviewActiveElement(document.activeElement) === "eligible"
  );
};

const resolveExternalPromptMirrorMode = async (): Promise<boolean | null> => {
  if (!isTauriRuntime()) {
    return null;
  }
  const nativeResult = await commands.checkTypingTipTargetEligibility();
  if (nativeResult.status !== "ok" || nativeResult.data !== "eligible") {
    return null;
  }
  if (await isMainWindowCurrentlyVisible()) {
    return false;
  }
  const pillVisibility = getEffectivePillVisibility(
    getMyUserPreferences(getAppState())?.dictationPillVisibility,
  );
  return pillVisibility === "persistent" ? true : null;
};

const canBeginTargetProbe = (
  pathname: string,
  isStale: () => boolean,
): boolean => {
  if (isStale()) {
    return false;
  }
  const state = getAppState();
  return (
    state.voiceTypingTipPrompt === null &&
    getVoiceTypingTipExclusionReason(state, pathname) === null
  );
};

const probeTargetAndShowPrompt = async (
  getPathname: () => string,
  isStale: () => boolean,
): Promise<void> => {
  if (!canBeginTargetProbe(getPathname(), isStale)) {
    return;
  }

  if (typeof document !== "undefined" && document.hasFocus()) {
    if ((await isFocusedWebviewEligible()) && !isStale()) {
      showVoiceTypingTipPrompt({
        pathname: getPathname(),
        mirrorToPill: false,
      });
    }
    return;
  }

  const mirrorToPill = await resolveExternalPromptMirrorMode();
  if (mirrorToPill !== null && !isStale()) {
    showVoiceTypingTipPrompt({
      pathname: getPathname(),
      mirrorToPill,
    });
  }
};

const isNativeKeyStreamActive = (): boolean => {
  if (!isTauriRuntime()) {
    return false;
  }
  const state = getAppState();
  return globalKeyStreamIsLive(
    state.hotkeyStrategy,
    state.keyboardListenerHealth,
  );
};

/**
 * Watches sustained prose typing across both native `keysHeld` transitions and
 * focused-webview `KeyboardEvent.code` fallbacks without reading any typed
 * text, field values, or clipboard contents.
 */
export const VoiceTypingTipSideEffects = () => {
  const isMainWindow = isEligibleHostWindow();
  const { pathname } = useLocation();
  const pathnameRef = useRef(pathname);
  const detectorRef = useRef(new SustainedTypingDetector());
  const probeInFlightRef = useRef(false);

  useEffect(() => {
    pathnameRef.current = pathname;
    const state = getAppState();
    if (shouldClearVisibleVoiceTypingTip(state, pathname)) {
      detectorRef.current.reset();
      if (state.voiceTypingTipPrompt !== null) {
        dismissVoiceTypingTip({ applyCooldown: false });
      }
    }
  }, [pathname]);

  useEffect(() => {
    if (!isMainWindow) {
      return;
    }

    let probeGeneration = 0;

    registerVoiceTypingTipCooldownListener((untilMs) => {
      probeGeneration += 1;
      detectorRef.current.applyCooldown(untilMs);
    });

    const triggerWhenTargetSafe = async () => {
      if (probeInFlightRef.current) {
        return;
      }
      probeInFlightRef.current = true;
      const generationAtStart = ++probeGeneration;
      detectorRef.current.reset();
      try {
        await probeTargetAndShowPrompt(
          () => pathnameRef.current,
          () => probeGeneration !== generationAtStart,
        );
      } catch {
        // Any focus-probe failure conservatively suppresses the tip.
      } finally {
        probeInFlightRef.current = false;
      }
    };

    let previousKeysHeld = getAppState().keysHeld;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (
        getVoiceTypingTipExclusionReason(state, pathnameRef.current) !== null
      ) {
        probeGeneration += 1;
        detectorRef.current.reset();
        previousKeysHeld = state.keysHeld;
        if (state.voiceTypingTipPrompt !== null) {
          dismissVoiceTypingTip({ applyCooldown: false });
        }
        return;
      }

      if (state.keysHeld === previousKeysHeld) {
        return;
      }
      previousKeysHeld = state.keysHeld;
      if (state.voiceTypingTipPrompt !== null) {
        return;
      }

      const progress = detectorRef.current.onHeldKeysChange(
        state.keysHeld,
        collectConfiguredHotkeyCombos(state),
        Date.now(),
      );
      if (progress.readyToTrigger) {
        void triggerWhenTargetSafe();
      }
    });

    const handleFallbackKeyDown = (event: KeyboardEvent) => {
      if (isNativeKeyStreamActive()) {
        return;
      }
      const state = getAppState();
      if (
        state.voiceTypingTipPrompt !== null ||
        getVoiceTypingTipExclusionReason(state, pathnameRef.current) !== null
      ) {
        detectorRef.current.reset();
        return;
      }

      const progress = detectorRef.current.onDiscreteKeyDown(
        htmlCodeToRdevLabel(event.code),
        {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
        },
        collectConfiguredHotkeyCombos(state),
        Date.now(),
      );
      if (progress.readyToTrigger) {
        void triggerWhenTargetSafe();
      }
    };

    window.addEventListener("keydown", handleFallbackKeyDown, true);
    // A prompt that outlives its typing context must not linger over a
    // password or otherwise masked field the user moves into. Context-driven
    // clears apply no cooldown and never count toward the "No thanks"
    // auto-disable history.
    const handleFocusIn = (event: FocusEvent) => {
      const state = getAppState();
      if (state.voiceTypingTipPrompt === null) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (classifyWebviewActiveElement(target) === "secure_input") {
        dismissVoiceTypingTip({ applyCooldown: false });
      }
    };
    window.addEventListener("focusin", handleFocusIn, true);
    return () => {
      probeGeneration += 1;
      window.removeEventListener("keydown", handleFallbackKeyDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
      unsubscribe();
      registerVoiceTypingTipCooldownListener(null);
      resetVoiceTypingTipSessionState();
    };
  }, [isMainWindow]);

  useToastAction((payload) => {
    if (
      payload.action !== "voice_typing_tip_try" &&
      payload.action !== "voice_typing_tip_setup" &&
      payload.action !== "voice_typing_tip_no_thanks"
    ) {
      return;
    }
    if (payload.proposalId !== getVisibleVoiceTypingTipPromptId()) {
      return;
    }
    if (payload.action === "voice_typing_tip_no_thanks") {
      declineVoiceTypingTipWithNoThanks({ fromPillClick: true });
      return;
    }
    acceptVoiceTypingTip({ fromPillClick: true });
  });

  return null;
};
