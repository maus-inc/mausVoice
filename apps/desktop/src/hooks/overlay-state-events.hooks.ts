import { produceAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import { useTauriListen } from "./tauri.hooks";

type OverlayPhasePayload = { phase: OverlayPhase };
type RecordingLevelPayload = { levels?: number[] };

/** Mirror native overlay phase and sanitized recording levels into the store. */
export function useOverlayStateEvents() {
  useTauriListen<OverlayPhasePayload>("overlay_phase", (payload) => {
    produceAppState((draft) => {
      draft.overlayPhase = payload.phase;
      if (payload.phase !== "recording") {
        draft.audioLevels = [];
      }
    });
  });

  useTauriListen<RecordingLevelPayload>("recording_level", (payload) => {
    const raw = Array.isArray(payload.levels) ? payload.levels : [];
    const sanitized = raw.map((value) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0,
    );

    produceAppState((draft) => {
      draft.audioLevels = sanitized;
    });
  });
}
