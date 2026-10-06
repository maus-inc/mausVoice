import type { TranscriptionSession } from "../types/transcription-session.types";
import { withTimeout } from "../utils/timeout.utils";

export const LIVE_PROVIDER_STARTUP_TIMEOUT_MS = 15_000;

export const startLiveProviderSession = ({
  session,
  sampleRate,
  controller,
  timeoutMs = LIVE_PROVIDER_STARTUP_TIMEOUT_MS,
}: {
  session: TranscriptionSession;
  sampleRate: number;
  controller: AbortController;
  timeoutMs?: number;
}): Promise<void> => {
  const startup = session.onRecordingStart(sampleRate, controller.signal);
  return withTimeout(
    startup,
    timeoutMs,
    "Live transcription provider startup",
    () =>
      controller.abort(
        new DOMException("Provider startup timed out", "TimeoutError"),
      ),
  );
};

export const getStartupAbortReason = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException("The operation was aborted", "AbortError");

export const addStartupAbortListener = (
  signal: AbortSignal | undefined,
  onAbort: (reason: unknown) => void,
): (() => void) => {
  if (!signal) return () => undefined;

  let listening = true;
  const handleAbort = () => {
    if (!listening) return;
    onAbort(getStartupAbortReason(signal));
  };

  if (signal.aborted) {
    handleAbort();
    return () => {
      listening = false;
    };
  }

  signal.addEventListener("abort", handleAbort, { once: true });
  return () => {
    listening = false;
    signal.removeEventListener("abort", handleAbort);
  };
};
