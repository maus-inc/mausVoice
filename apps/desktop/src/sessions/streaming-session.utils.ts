import { getLogger } from "../utils/log.utils";
import { addStartupAbortListener } from "./provider-startup.utils";
import type { AudioChunkBuffer } from "./transcription-stream.utils";

/**
 * Shared machinery for the live-provider WebSocket sessions (Deepgram,
 * AssemblyAI, ElevenLabs). Each provider's message protocol differs, but
 * socket teardown, startup settlement, finalize bookkeeping, and the buffered
 * chunk writer are identical shape; keeping them here is what stops the three
 * session files from drifting into near-copies of each other.
 */

/**
 * Tears down a provider socket: tolerates an already-CLOSED socket, logs and
 * recovers when `close()` throws, and always resets the audio buffer so queued
 * samples release their memory.
 *
 * Callers must detach their own socket reference BEFORE calling this
 * (`const socket = ws; ws = null; closeStreamingSocket(socket, ...)`): a fake
 * or browser socket may fire `onclose` synchronously inside `close()`, and the
 * session's `onclose` handler cleans up again, which must observe the detached
 * reference instead of closing the socket a second time.
 */
export const closeStreamingSocket = (
  socket: WebSocket | null,
  resetBuffers: () => void,
  loggerPrefix: string,
): void => {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    try {
      socket.close();
    } catch (error) {
      getLogger().warning(
        `[${loggerPrefix}] Failed to close the WebSocket: ${error}`,
      );
    }
  }
  resetBuffers();
};

export type StartupSettler = {
  /** True once startup has resolved or rejected; later callbacks cannot unsettle it. */
  readonly settled: boolean;
  /** Rejects startup after cleanup; a no-op once settled. */
  rejectStartup: (reason: unknown) => void;
  /** Resolves startup with the session; a no-op once settled. */
  resolveStartup: () => void;
};

/**
 * The resolve/reject pair a provider socket settles exactly once, mirrored off
 * the surrounding Promise executor. An already-aborted signal rejects
 * synchronously (matching `addStartupAbortListener`), so callers must check
 * `settler.settled` before opening the socket.
 */
export const createStartupSettler = <T>(options: {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  resolve: (session: T) => void;
  reject: (reason?: unknown) => void;
  session: T;
}): StartupSettler => {
  let settled = false;
  // No-op initial value: an already-aborted signal rejects synchronously
  // inside addStartupAbortListener, before the remover exists.
  let removeAbortListener: () => void = () => undefined;

  const rejectStartup = (reason: unknown) => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    options.cleanup();
    options.reject(reason);
  };
  const resolveStartup = () => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    options.resolve(options.session);
  };

  removeAbortListener = addStartupAbortListener(options.signal, rejectStartup);

  return {
    get settled() {
      return settled;
    },
    rejectStartup,
    resolveStartup,
  };
};

/**
 * Wires the protocol-independent socket handlers: a socket error or a close
 * before startup settles rejects startup; afterwards they only clean up, plus
 * any provider-specific settled-close work (Deepgram settles a pending
 * finalize there).
 */
export const attachStreamingSocketHandlers = (options: {
  socket: WebSocket;
  settler: StartupSettler;
  cleanup: () => void;
  loggerPrefix: string;
  earlyCloseErrorMessage: string;
  closeLogLevel?: "info" | "verbose";
  onSettledClose?: () => void;
}): void => {
  const {
    socket,
    settler,
    cleanup,
    loggerPrefix,
    earlyCloseErrorMessage,
    closeLogLevel = "verbose",
    onSettledClose,
  } = options;

  socket.onerror = (error) => {
    getLogger().error(`[${loggerPrefix}] WebSocket error:`, error);
    if (!settler.settled) {
      settler.rejectStartup(new Error("WebSocket connection failed"));
    } else {
      cleanup();
    }
  };

  socket.onclose = (event) => {
    const closeLog = {
      code: event.code,
      reason: event.reason,
    };
    if (closeLogLevel === "info") {
      getLogger().info(`[${loggerPrefix}] WebSocket closed:`, closeLog);
    } else {
      getLogger().verbose(`[${loggerPrefix}] WebSocket closed:`, closeLog);
    }
    if (!settler.settled) {
      settler.rejectStartup(new Error(earlyCloseErrorMessage));
      return;
    }
    onSettledClose?.();
    cleanup();
  };
};

export type FinalizeBookkeeper = {
  /** True while a finalize call is holding a resolver. */
  readonly pending: boolean;
  /** Registers the resolver of an in-flight finalize. */
  begin: (resolveCurrentText: (text: string) => void) => void;
  /** Sets the "stop waiting for the final transcript" deadline. */
  armTimeout: (timeoutMs: number, timeoutMessage: string) => void;
  /**
   * Settles the pending finalize (if any): clears the timeout, cleans up the
   * socket, and resolves with the accumulated transcript.
   */
  complete: () => void;
};

/**
 * The timeout/resolver bookkeeping shared by the providers that wait for the
 * server to flush a final transcript after being told the stream is over.
 */
export const createFinalizeBookkeeper = (options: {
  cleanup: () => void;
  getText: () => string;
  loggerPrefix: string;
}): FinalizeBookkeeper => {
  const { cleanup, getText, loggerPrefix } = options;
  let resolver: ((text: string) => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const complete = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (resolver) {
      getLogger().verbose(
        `[${loggerPrefix}] Completing finalize with transcript length:`,
        getText().length,
      );
      cleanup();
      resolver(getText());
      resolver = null;
    }
  };

  return {
    get pending() {
      return resolver !== null;
    },
    begin: (resolveCurrentText) => {
      resolver = resolveCurrentText;
    },
    armTimeout: (timeoutMs, timeoutMessage) => {
      timeout = setTimeout(() => {
        getLogger().verbose(
          `[${loggerPrefix}] ${timeoutMessage}`,
          getText().length,
        );
        complete();
      }, timeoutMs);
    },
    complete,
  };
};

/**
 * Streams every chunk into the provider socket's send buffer, even while the
 * socket is still connecting: `flush()` is a no-op until the socket is OPEN
 * and `onopen` drains the backlog, so speech captured during connect is not
 * lost. Chunks written after finalization are dropped.
 */
export const createBufferedChunkWriter = (options: {
  buffer: AudioChunkBuffer;
  isFinalized: () => boolean;
  loggerPrefix: string;
}): ((chunk: Float32Array) => void) => {
  const { buffer, isFinalized, loggerPrefix } = options;
  return (chunk) => {
    if (isFinalized()) return;
    try {
      buffer.push(chunk);
      buffer.flush(false);
    } catch (error) {
      getLogger().error(`[${loggerPrefix}] Error sending audio chunk:`, error);
    }
  };
};
