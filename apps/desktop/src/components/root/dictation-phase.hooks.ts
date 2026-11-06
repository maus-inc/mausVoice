import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import { getAppState } from "../../store";
import type { OverlayPhase } from "../../types/overlay.types";
import { getLogger } from "../../utils/log.utils";
import { sendPillStageText } from "../../utils/overlay.utils";

export const createPhaseBookkeeper = (): {
  issue: () => number;
  isCurrent: (seq: number) => boolean;
  markSent: (seq: number, phase: OverlayPhase) => void;
  getLastSent: () => OverlayPhase | null;
} => {
  let issued = 0;
  let lastSent: OverlayPhase | null = null;
  return {
    issue: () => ++issued,
    isCurrent: (seq) => seq === issued,
    markSent: (seq, phase) => {
      if (seq === issued) lastSent = phase;
    },
    getLastSent: () => lastSent,
  };
};

/** Own ordered phase bookkeeping and the main-window idle reconciliation. */
export function usePillPhaseSync(isMainWindow: boolean) {
  const bookkeeperRef = useRef(createPhaseBookkeeper());
  const sendPhase = useCallback(async (phase: OverlayPhase) => {
    if (phase === "idle") sendPillStageText(null);
    const bookkeeper = bookkeeperRef.current;
    const seq = bookkeeper.issue();
    try {
      await invoke<void>("set_phase", { phase });
      bookkeeper.markSent(seq, phase);
    } catch (error) {
      if (!bookkeeper.isCurrent(seq)) return;
      getLogger().warning(
        `Failed to send phase ${phase} to pill: ${error}; retrying once`,
      );
      try {
        await invoke<void>("set_phase", { phase });
        bookkeeper.markSent(seq, phase);
      } catch (retryError) {
        getLogger().error(
          `Failed to send phase ${phase} to pill on retry: ${retryError}`,
        );
      }
    }
  }, []);
  useEffect(() => {
    if (!isMainWindow) return;
    const interval = setInterval(() => {
      if (
        getAppState().activeRecordingMode !== null ||
        bookkeeperRef.current.getLastSent() === "idle"
      )
        return;
      sendPhase("idle");
    }, 5_000);
    return () => clearInterval(interval);
  }, [isMainWindow, sendPhase]);
  return sendPhase;
}
