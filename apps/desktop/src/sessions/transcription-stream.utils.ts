import { convertFloat32ToPCM16 } from "@maus-inc/voice-ai";
import { getLogger } from "../utils/log.utils";

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

export const createAudioChunkBuffer = (
  ws: () => WebSocket | null,
  config: AudioChunkBufferConfig,
): AudioChunkBuffer & { sentChunkCount: () => number } => {
  const { sampleRate, minChunkDurationMs, maxChunkDurationMs, loggerPrefix } =
    config;

  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * minChunkDurationMs) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * maxChunkDurationMs) / 1000),
  );

  let pendingChunks: Float32Array[] = [];
  let pendingSampleCount = 0;
  let sentChunkCount = 0;

  const drainSamples = (targetCount: number): Float32Array => {
    if (targetCount <= 0) {
      return new Float32Array(0);
    }
    const output = new Float32Array(targetCount);
    let filled = 0;

    while (filled < targetCount && pendingChunks.length > 0) {
      const current = pendingChunks[0];
      const remaining = targetCount - filled;
      if (current.length <= remaining) {
        output.set(current, filled);
        filled += current.length;
        pendingChunks.shift();
      } else {
        output.set(current.subarray(0, remaining), filled);
        pendingChunks[0] = current.subarray(remaining);
        filled += remaining;
      }
    }

    pendingSampleCount = Math.max(0, pendingSampleCount - filled);
    return filled === targetCount ? output : output.subarray(0, filled);
  };

  const flush = (force = false) => {
    const socket = ws();
    if (!socket?.OPEN || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (sendNextChunk(socket, force)) {
      // drain the buffer
    }
  };

  const sendNextChunk = (socket: WebSocket, force: boolean): boolean => {
    const available = pendingSampleCount;
    if (available < minSamplesPerChunk && !(force && available > 0)) {
      return false;
    }
    const chunkSize =
      available >= maxSamplesPerChunk ? maxSamplesPerChunk : available;
    let chunk = drainSamples(chunkSize);
    if (force && chunk.length > 0 && chunk.length < minSamplesPerChunk) {
      const padded = new Float32Array(minSamplesPerChunk);
      padded.set(chunk);
      chunk = padded;
    }
    if (chunk.length === 0) {
      return false;
    }
    return trySendChunk(socket, chunk);
  };

  const trySendChunk = (socket: WebSocket, chunk: Float32Array): boolean => {
    try {
      const pcm16 = convertFloat32ToPCM16(chunk);
      socket.send(pcm16);
      sentChunkCount++;
      if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
        const durationMs = (chunk.length / sampleRate) * 1000;
        getLogger().verbose(
          `[${loggerPrefix}] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${pcm16.byteLength} bytes)`,
        );
      }
      return true;
    } catch (error) {
      getLogger().error(
        `[${loggerPrefix}] Error sending buffered chunk:`,
        error,
      );
      return false;
    }
  };

  return {
    push: (chunk) => {
      pendingChunks.push(chunk);
      pendingSampleCount += chunk.length;
    },
    flush,
    reset: () => {
      pendingChunks = [];
      pendingSampleCount = 0;
    },
    pendingSampleCount: () => pendingSampleCount,
    sentChunkCount: () => sentChunkCount,
  };
};

export type ReceivedChunkLogger = {
  record: (sampleCount: number) => number;
};

export const createReceivedChunkLogger = (
  loggerPrefix: string,
): ReceivedChunkLogger => {
  let count = 0;
  return {
    record: (sampleCount) => {
      count++;
      if (count <= 3 || count % 10 === 0) {
        getLogger().verbose(
          `[${loggerPrefix}] Received chunk #${count}, samples:`,
          sampleCount,
        );
      }
      return count;
    },
  };
};
