import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isEqual } from "lodash-es";
import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import {
  buildNativePillPayload,
  selectNativePillState,
  type NativePillSyncState,
  type NativePillPayload,
} from "./native-pill-payload";

export const OverlaySyncSideEffects = () => {
  useNativePillAssistantSync();

  return null;
};

const useNativePillAssistantSync = () => {
  const state = useAppStore(selectNativePillState);
  const intl = useIntl();
  const prevRef = useRef<{
    state: NativePillSyncState;
    intl: typeof intl;
  } | null>(null);

  useEffect(() => {
    // Only the main window owns the assistant pill. The composer popout is a
    // separate webview with its own empty store, so pushing its (likely empty)
    // assistant state to native would blank or reset the live pill.
    if (getCurrentWindow().label !== "main") {
      return;
    }
    if (
      prevRef.current !== null &&
      prevRef.current.intl === intl &&
      isEqual(prevRef.current.state, state)
    ) {
      return;
    }
    prevRef.current = { state, intl };

    const payload: NativePillPayload = buildNativePillPayload(state, intl);

    invoke("sync_native_pill_assistant", {
      payload: JSON.stringify(payload),
    }).catch((error) => {
      getLogger().error("Failed to sync pill assistant state", error);
    });
  }, [state, intl]);
};
