import { getRec } from "@maus-inc/utilities";
import { useEffect, useRef } from "react";
import type { IntlShape } from "react-intl";
import { refreshRemoteReceiverStatus } from "../actions/remote-receiver.actions";
import { handleRemoteFinalTextReceived } from "../actions/remote-transcript.actions";
import { getAppState, useAppStore } from "../store";
import { isPermissionAuthorized } from "../utils/permission.utils";
import { useAppStartup } from "./app-startup.hooks";
import { useHotkeyInputEvents } from "./hotkey-input-events.hooks";
import { useKeyboardListenerEvents } from "./keyboard-listener-events.hooks";
import { useNativeCapabilities } from "./native-capabilities.hooks";
import { useNativeFeedbackSync } from "./native-feedback-sync.hooks";
import { useNativeKeyboardListener } from "./native-keyboard-listener.hooks";
import { useOverlayStateEvents } from "./overlay-state-events.hooks";
import { useTauriListen } from "./tauri.hooks";

type RemoteFinalTextReceivedPayload = {
  senderDeviceId: string;
  eventId: string;
  text: string;
  mode: string;
  createdAt: string;
};

/** Own process-wide native input, overlay and remote events for this window. */
export function useAppRuntimeEffects({
  isMainWindow,
  intl,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
}) {
  const lifecycle = useRef({ generation: 0, active: false });
  useEffect(() => {
    lifecycle.current.generation += 1;
    lifecycle.current.active = true;
    return () => {
      lifecycle.current.active = false;
      lifecycle.current.generation += 1;
    };
  }, [isMainWindow]);

  const keyPermAuthorized = useAppStore((state) =>
    isPermissionAuthorized(getRec(state.permissions, "accessibility")?.state),
  );

  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);

  useNativeCapabilities();

  useNativeKeyboardListener({
    isMainWindow,
    hotkeyStrategy,
    keyPermAuthorized,
  });

  useNativeFeedbackSync(isMainWindow);
  useAppStartup(isMainWindow);

  useOverlayStateEvents();

  useHotkeyInputEvents(isMainWindow);

  useKeyboardListenerEvents({ isMainWindow, intl });

  useTauriListen<RemoteFinalTextReceivedPayload>(
    "remote_final_text_received",
    async (payload) => {
      // Inserting the remote transcript is a window-global action; only the
      // main window must perform it to avoid double-insertion from a popout.
      if (!isMainWindow || !lifecycle.current.active) {
        return;
      }
      const generation = lifecycle.current.generation;
      const state = getAppState();
      const userId = state.auth?.uid ?? null;
      const authSessionNonce = state.authSessionNonce;
      const isCurrent = () => {
        const current = getAppState();
        return (
          lifecycle.current.active &&
          lifecycle.current.generation === generation &&
          (current.auth?.uid ?? null) === userId &&
          current.authSessionNonce === authSessionNonce
        );
      };
      await handleRemoteFinalTextReceived(payload, isCurrent);
      if (isCurrent()) {
        await refreshRemoteReceiverStatus().catch(() => undefined);
      }
    },
  );
}
