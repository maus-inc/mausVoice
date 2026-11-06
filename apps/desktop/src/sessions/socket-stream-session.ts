import { getLogger } from "../utils/log.utils";
import { createAcknowledgedStreamFinalization } from "./acknowledged-stream-finalization";
import {
  createAudioChunkBuffer,
  createWebSocketStartup,
  enqueueStreamingAudio,
} from "./transcription-stream.utils";

/** What a started socket stream hands back to its transcription session. */
export type SocketStreamSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk: (chunk: Float32Array) => void;
};

/**
 * The stream lifecycle a provider's message handler may drive. A provider
 * decides which frames mean "the stream ended" and which mean "the stream
 * failed"; this module owns what those decisions do to the connection.
 */
export type SocketStreamControl = {
  /** True once a provider finalization is in flight. */
  isFinalizing: () => boolean;
  /** True once this recording has started finalizing. */
  isFinalized: () => boolean;
  /** Finish the pending finalization and keep the transcript. */
  complete: () => void;
  /** Fail the pending finalization with a reason safe to show a user. */
  fail: (reason: string) => void;
  /** Drop the socket after a transport failure during recording. */
  markDeliveryFailed: () => void;
};

export type SocketStreamOptions = {
  loggerPrefix: string;
  sampleRate: number;
  /** Provider minimum batch, in milliseconds, before a chunk is sent. */
  minChunkDurationMs: number;
  /** Frame body that commits the stream, sent as `{"type": <value>}`. */
  terminationMessage: string;
  /** Provider verbosity for routine progress and close messages. */
  log: (message: string, ...args: unknown[]) => void;
  /** Read the accumulated transcript; the provider owns the accumulator. */
  getText: () => string;
  createSocket: () => WebSocket;
  /** Runs inside the open handler, before buffered audio is flushed. */
  onConnect?: () => void;
  /** Runs after the buffered audio was flushed to the provider. */
  onReady?: () => void;
  /** Provider message handling. Unrecognised frames must be ignored. */
  onMessage: (
    data: Record<string, unknown>,
    control: SocketStreamControl,
  ) => void;
};

const FINALIZATION_TIMEOUT_MS = 15_000;
const MAX_CHUNK_DURATION_MS = 100;
const CONNECTION_LOST = "Streaming audio connection was lost";

/**
 * Share one implementation of the buffered-socket lifecycle: audio buffering,
 * the close-triggered teardown, and the acknowledged finalization handshake that
 * waits for the provider's own end-of-stream frame. Providers keep their URL,
 * their frame handling, and their log level, because those are the parts that
 * actually differ between them.
 */
export const startSocketStreamSession = (
  options: SocketStreamOptions,
): Promise<SocketStreamSession> => {
  const {
    loggerPrefix,
    sampleRate,
    minChunkDurationMs,
    terminationMessage,
    log,
    getText,
    createSocket,
    onConnect,
    onReady,
    onMessage,
  } = options;

  let ws: WebSocket | null = null;
  let isFinalized = false;
  let deliveryFailed = false;

  const buffer = createAudioChunkBuffer(() => ws, {
    sampleRate,
    minChunkDurationMs,
    maxChunkDurationMs: MAX_CHUNK_DURATION_MS,
    loggerPrefix,
  });

  const cleanup = () => {
    if (finalization.isPending()) {
      finalization.fail("Streaming audio finalization was cancelled");
      return;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      ws = null;
    }
    buffer.reset();
  };

  const finalization = createAcknowledgedStreamFinalization({
    loggerPrefix,
    timeoutMs: FINALIZATION_TIMEOUT_MS,
    cleanup,
    getText,
    prepare: () => {
      if (deliveryFailed || ws?.readyState !== WebSocket.OPEN) {
        return CONNECTION_LOST;
      }
      isFinalized = true;
      buffer.flush(true);
      if (buffer.hasSendFailure() || buffer.pendingSampleCount() > 0) {
        return "Streaming audio could not be sent";
      }
      log(`[${loggerPrefix}] Total chunks sent:`, buffer.sentChunkCount());
      if (ws?.readyState !== WebSocket.OPEN) {
        return CONNECTION_LOST;
      }
      return null;
    },
    sendTermination: () => {
      if (ws?.readyState !== WebSocket.OPEN) {
        throw new Error(CONNECTION_LOST);
      }
      ws.send(JSON.stringify({ type: terminationMessage }));
    },
  });

  const writeAudioChunk = (chunk: Float32Array) => {
    if (isFinalized || deliveryFailed) return;
    if (ws?.readyState !== WebSocket.OPEN) {
      deliveryFailed = true;
      cleanup();
      return;
    }
    if (
      !enqueueStreamingAudio(buffer, chunk, loggerPrefix) ||
      buffer.hasSendFailure()
    ) {
      deliveryFailed = true;
      cleanup();
    }
  };

  return new Promise((resolve, reject) => {
    ws = createSocket();
    // Handshake failures and closes must settle startup rather than leave the
    // session waiting for an open event that will never arrive.
    const startup = createWebSocketStartup(
      loggerPrefix,
      cleanup,
      resolve,
      reject,
    );
    ws.onopen = () =>
      startup.open(() => {
        onConnect?.();
        buffer.flush(false);
        onReady?.();
        return { finalize: finalization.finalize, cleanup, writeAudioChunk };
      });

    const control: SocketStreamControl = {
      isFinalizing: () => isFinalized && finalization.isPending(),
      isFinalized: () => isFinalized,
      complete: () => finalization.complete(),
      fail: (reason: string) => finalization.fail(reason),
      markDeliveryFailed: () => {
        deliveryFailed = true;
        cleanup();
      },
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Server-controlled fields can contain dictated text or credentials.
        log(`[${loggerPrefix}] Received message`);
        onMessage(data, control);
      } catch {
        // Parser and consumer exceptions can contain provider-supplied text.
        getLogger().error(`[${loggerPrefix}] Error processing message`);
      }
    };

    ws.onerror = (event) => {
      if (isFinalized && finalization.isPending()) {
        finalization.fail(CONNECTION_LOST);
        return;
      }
      if (!isFinalized) deliveryFailed = true;
      startup.error(event);
    };

    ws.onclose = (event) => {
      log(`[${loggerPrefix}] WebSocket closed:`, { code: event.code });
      // A close before the handshake finished settles nothing on its own: the
      // startup helper already reports it, and the session was never ready.
      if (startup.closedBeforeOpen()) return;
      if (!isFinalized) deliveryFailed = true;
      if (isFinalized && finalization.isPending()) {
        finalization.fail(
          "Streaming audio ended before finalization completed",
        );
        return;
      }
      cleanup();
    };
  });
};
