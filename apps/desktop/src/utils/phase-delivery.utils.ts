import type { OverlayPhase } from "../types/overlay.types";
import { getLogger } from "./log.utils";
import { captureSyncThrow } from "./promise.utils";

/** A cosmetic phase reply must not hold audio stop or cancellation open. */
export function sendPhaseWithoutWaiting(
  send: (phase: OverlayPhase) => Promise<void>,
  phase: OverlayPhase,
): void {
  // Both a synchronous throw and a rejection are the same cosmetic failure, and
  // the synchronous one is reported on this tick rather than a later one.
  const started = captureSyncThrow(() => send(phase));
  if (!started.ok) {
    getLogger().warning(`Could not request pill phase ${phase}`);
    return;
  }
  void started.value.catch(() => {
    getLogger().warning(`Could not request pill phase ${phase}`);
  });
}
