/**
 * Tracks active `simulate_type` sessions plus a short post-completion drain
 * window so synthetic key events emitted by mausVoice's own simulated typing
 * output cannot be mistaken for sustained human typing.
 */

const SIMULATED_TYPING_DRAIN_MS = 400;

let activeSimulatedTypingSessions = 0;
let suppressUntilMs = 0;

export const beginSimulatedTypingGuard = (): void => {
  activeSimulatedTypingSessions += 1;
};

export const endSimulatedTypingGuard = (nowMs: number = Date.now()): void => {
  activeSimulatedTypingSessions = Math.max(
    0,
    activeSimulatedTypingSessions - 1,
  );
  suppressUntilMs = Math.max(
    suppressUntilMs,
    nowMs + SIMULATED_TYPING_DRAIN_MS,
  );
};

export const isSimulatedTypingSuppressed = (
  nowMs: number = Date.now(),
): boolean => {
  return activeSimulatedTypingSessions > 0 || nowMs < suppressUntilMs;
};

export const resetSimulatedTypingGuardForTests = (): void => {
  activeSimulatedTypingSessions = 0;
  suppressUntilMs = 0;
};
