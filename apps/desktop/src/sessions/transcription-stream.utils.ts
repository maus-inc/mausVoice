import { convertFloat32ToPCM16 } from "@maus-inc/voice-ai";
import { getLogger } from "../utils/log.utils";
import {
  audioChunkSampleBounds,
  drainSamples,
  padFinalAudioChunk,
} from "./audio-buffer.utils";

// WebSocket.send queues bytes in the browser; an OPEN socket can still be
// stalled indefinitely. Bound that queue and fail the recording instead of
// retaining unbounded audio or silently dropping later samples.
export const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;

export type AudioChunkBufferConfig = {
  sampleRate: number;
  minChunkDurationMs: number;
  maxChunkDurationMs: number;
  loggerPrefix: string;
};

export type AudioChunkBuffer = {
  push: (chunk: Float32Array) => void;
  flush: (force?: boolean) => void;
  reset: () => void;
  pendingSampleCount: () => number;
};

/** Queue samples even while connecting, then flush if the socket is open. */
export const enqueueStreamingAudio = (
  buffer: AudioChunkBuffer,
  chunk: Float32Array,
  loggerPrefix: string,
): boolean => {
  try {
    buffer.push(chunk);
    buffer.flush(false);
    return true;
  } catch {
    // Exceptions can contain provider-controlled data or recorded audio.
    getLogger().error(`[${loggerPrefix}] Error sending audio chunk`);
    return false;
  }
};

export const createAudioChunkBuffer = (
  ws: () => WebSocket | null,
  config: AudioChunkBufferConfig,
): AudioChunkBuffer & {
  sentChunkCount: () => number;
  hasSendFailure: () => boolean;
} => {
  const { sampleRate, minChunkDurationMs, maxChunkDurationMs, loggerPrefix } =
    config;

  const { minSamplesPerChunk, maxSamplesPerChunk } = audioChunkSampleBounds(
    sampleRate,
    minChunkDurationMs,
    maxChunkDurationMs,
  );

  let pendingChunks: Float32Array[] = [];
  const pendingSampleCountRef = { value: 0 };
  let sentChunkCount = 0;
  let sendFailed = false;

  const drain = (targetCount: number) =>
    drainSamples(pendingChunks, pendingSampleCountRef, targetCount);

  const trySendChunk = (socket: WebSocket, chunk: Float32Array): boolean => {
    try {
      const pcm16 = convertFloat32ToPCM16(chunk);
      if (
        (socket.bufferedAmount ?? 0) + pcm16.byteLength >
        MAX_SOCKET_BUFFERED_BYTES
      ) {
        sendFailed = true;
        getLogger().warning(
          `[${loggerPrefix}] WebSocket audio queue limit reached`,
        );
        return false;
      }
      socket.send(pcm16);
      sentChunkCount++;
      if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
        const durationMs = (chunk.length / sampleRate) * 1000;
        getLogger().verbose(
          `[${loggerPrefix}] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${pcm16.byteLength} bytes)`,
        );
      }
      return true;
    } catch {
      sendFailed = true;
      getLogger().error(`[${loggerPrefix}] Error sending buffered chunk`);
      return false;
    }
  };

  const sendNextChunk = (socket: WebSocket, force: boolean): boolean => {
    const available = pendingSampleCountRef.value;
    if (available < minSamplesPerChunk && !(force && available > 0)) {
      return false;
    }
    const chunkSize = Math.min(available, maxSamplesPerChunk);
    const originalChunk = drain(chunkSize);
    const chunk = padFinalAudioChunk(originalChunk, minSamplesPerChunk, force);
    if (chunk.length === 0) {
      return false;
    }
    const sent = trySendChunk(socket, chunk);
    if (!sent) {
      pendingChunks.unshift(originalChunk);
      pendingSampleCountRef.value += originalChunk.length;
      return false;
    }
    return true;
  };

  const flush = (force = false) => {
    const socket = ws();
    if (socket === null) {
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (sendNextChunk(socket, force)) {
      // drain the buffer
    }
  };

  return {
    push: (chunk) => {
      pendingChunks.push(chunk);
      pendingSampleCountRef.value += chunk.length;
    },
    flush,
    reset: () => {
      pendingChunks = [];
      pendingSampleCountRef.value = 0;
      sendFailed = false;
    },
    pendingSampleCount: () => pendingSampleCountRef.value,
    sentChunkCount: () => sentChunkCount,
    hasSendFailure: () => sendFailed,
  };
};

/** Bound the handshake so a silent connection cannot hold recording forever. */
export const WEBSOCKET_STARTUP_TIMEOUT_MS = 20_000;

/** Settle a WebSocket handshake once, including close without an error event. */
export const createWebSocketStartup = <T>(
  loggerPrefix: string,
  cleanup: () => void,
  resolve: (session: T) => void,
  reject: (reason: Error) => void,
) => {
  let state: "pending" | "opened" | "failed" = "pending";
  const fail = (_error: unknown) => {
    if (state === "failed") return;
    // Transport errors are untrusted and may include credentials or audio.
    getLogger().error(`[${loggerPrefix}] WebSocket connection failed`);
    state = "failed";
    clearTimeout(timer);
    cleanup();
    reject(new Error("WebSocket connection failed"));
  };
  const timer = setTimeout(
    () => fail(new Error("WebSocket connection timed out")),
    WEBSOCKET_STARTUP_TIMEOUT_MS,
  );
  return {
    open: (prepare: () => T) => {
      if (state !== "pending") return;
      try {
        const session = prepare();
        if (state !== "pending") return;
        state = "opened";
        clearTimeout(timer);
        resolve(session);
      } catch (error) {
        fail(error);
      }
    },
    error: fail,
    closedBeforeOpen: () => {
      if (state !== "pending") return false;
      state = "failed";
      clearTimeout(timer);
      cleanup();
      reject(new Error("WebSocket closed before the connection opened"));
      return true;
    },
  };
};
