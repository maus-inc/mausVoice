import { useEffect } from "react";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import type { BaseStrategy } from "../../strategies/base.strategy";
import { getLogger } from "../../utils/log.utils";
import { hasDictationBacklog } from "../../utils/output-routing.utils";

type PollOwner = { strategy: DictationStrategy; operation: number };

/** Bound queued backlog probes to one per recording, even when a focus probe hangs. */
export function useDictationBacklogDrain(
  isMainWindow: boolean,
  isActiveSession: boolean,
  strategyRef: { current: BaseStrategy | null },
  operationRef: { current: number },
  sessionRef: { current: (() => boolean) | null },
): void {
  useEffect(() => {
    if (!isMainWindow || !isActiveSession) return;
    let pending: PollOwner | null = null;
    let retired = false;
    const interval = setInterval(() => {
      const strategy = strategyRef.current;
      if (!(strategy instanceof DictationStrategy) || !hasDictationBacklog())
        return;
      const operation = operationRef.current;
      const session = sessionRef.current;
      if (!session?.()) return;
      if (pending?.strategy === strategy && pending.operation === operation)
        return;
      const owner = { strategy, operation };
      pending = owner;
      Promise.resolve()
        .then(() => {
          if (
            retired ||
            strategyRef.current !== strategy ||
            operationRef.current !== operation ||
            sessionRef.current !== session ||
            !session()
          )
            return;
          return strategy.checkAndDrainBacklog(
            () =>
              strategyRef.current === strategy &&
              operationRef.current === operation &&
              sessionRef.current === session &&
              session(),
          );
        })
        .catch((error: unknown) =>
          getLogger().warning(`Backlog drain poll failed: ${error}`),
        )
        .finally(() => {
          if (pending === owner) pending = null;
        });
    }, 1_000);
    return () => {
      retired = true;
      clearInterval(interval);
    };
  }, [isMainWindow, isActiveSession, strategyRef, operationRef, sessionRef]);
}
