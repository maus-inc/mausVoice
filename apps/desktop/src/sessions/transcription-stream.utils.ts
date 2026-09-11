import { convertFloat32ToPCM16 } from "@maus-inc/voice-ai";
import { getLogger } from "../utils/log.utils";
import { drainSamples } from "./audio-buffer.utils";

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
  const pendingSampleCountRef = { value: 0 };
  let sentChunkCount = 0;

  const drain = (targetCount: number) =>
    drainSamples(pendingChunks, pendingSampleCountRef, targetCount);

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

  const sendNextChunk = (socket: WebSocket, force: boolean): boolean => {
    const available = pendingSampleCountRef.value;
    if (available < minSamplesPerChunk && !(force && available > 0)) {
      return false;
    }
    const chunkSize = Math.min(available, maxSamplesPerChunk);
    let chunk = drain(chunkSize);
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
      pendingSampleCountRef.value += chunk.length;
    },
    flush,
    reset: () => {
      pendingChunks = [];
      pendingSampleCountRef.value = 0;
    },
    pendingSampleCount: () => pendingSampleCountRef.value,
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
