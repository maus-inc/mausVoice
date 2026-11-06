import { getLogger } from "../utils/log.utils";

/**
 * Finish a stream only after its provider's end-of-stream acknowledgement.
 * Utterance boundaries and socket writes are not evidence that all audio was
 * processed. A missing acknowledgement fails rather than returning partial text.
 */
export function createAcknowledgedStreamFinalization({
  prepare,
  sendTermination,
  cleanup,
  getText,
  loggerPrefix,
  timeoutMs,
}: {
  /** Flush buffered audio and return an error message if it cannot be sent. */
  prepare: () => string | null;
  sendTermination: () => void;
  cleanup: () => void;
  getText: () => string;
  loggerPrefix: string;
  timeoutMs: number;
}) {
  let resolvePending: ((text: string) => void) | null = null;
  let rejectPending: ((error: Error) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let result: Promise<string> | null = null;

  const isPending = () => resolvePending !== null;

  const settle = (errorMessage?: string) => {
    const resolve = resolvePending;
    const reject = rejectPending;
    if (!resolve || !reject) return;
    // Closing the socket can synchronously emit close; detach before cleanup.
    resolvePending = null;
    rejectPending = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      cleanup();
    } catch {
      getLogger().warning(`[${loggerPrefix}] Stream cleanup failed`);
    }
    if (errorMessage) {
      reject(new Error(errorMessage));
    } else {
      try {
        resolve(getText());
      } catch {
        reject(new Error("Streaming transcript could not be read"));
      }
    }
  };

  const fail = (message: string) => settle(message);
  const complete = () => settle();
  const finalize = (): Promise<string> => {
    if (result) return result;
    result = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    let failure: string | null;
    try {
      failure = prepare();
    } catch {
      failure = "Streaming audio could not be sent";
    }
    if (!isPending()) return result;
    if (failure) {
      fail(failure);
      return result;
    }
    try {
      sendTermination();
    } catch {
      fail("Streaming audio could not be finalized");
      return result;
    }
    // A test transport or another synchronous callback can settle during send.
    if (isPending()) {
      timer = setTimeout(
        () => fail("Streaming audio finalization timed out"),
        timeoutMs,
      );
    }
    return result;
  };

  return { finalize, complete, fail, isPending };
}
