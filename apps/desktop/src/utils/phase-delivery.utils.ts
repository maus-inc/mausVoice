import type { OverlayPhase } from "../types/overlay.types";
import { getLogger } from "./log.utils";

/** A cosmetic phase reply must not hold audio stop or cancellation open. */
export function sendPhaseWithoutWaiting(
  send: (phase: OverlayPhase) => Promise<void>,
  phase: OverlayPhase,
): void {
  try {
    void send(phase).catch(() => {
      getLogger().warning(`Could not request pill phase ${phase}`);
    });
  } catch {
    getLogger().warning(`Could not request pill phase ${phase}`);
  }
}
