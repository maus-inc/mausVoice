/**
 * Shared audio-buffering primitives for the WebSocket transcription
 * sessions. Each provider session feeds raw PCM float samples into a
 * buffer and drains fixed-size chunks; this module keeps that logic in
 * one place so the provider adapters only implement their protocol.
 */

export type AudioBufferController = {
  pushSamples: (samples: Float32Array) => void;
  drainSamples: (targetCount: number) => Float32Array;
  reset: () => void;
  getPendingSampleCount: () => number;
};

export const createAudioBufferController = (): AudioBufferController => {
  let pendingChunks: Float32Array[] = [];
  let pendingSampleCount = 0;

  const pushSamples = (samples: Float32Array) => {
    if (samples.length === 0) {
      return;
    }
    pendingChunks.push(samples);
    pendingSampleCount += samples.length;
  };

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

  const reset = () => {
    pendingChunks = [];
    pendingSampleCount = 0;
  };

  return {
    pushSamples,
    drainSamples,
    reset,
    getPendingSampleCount: () => pendingSampleCount,
  };
};

export type ChunkBounds = {
  minSamplesPerChunk: number;
  maxSamplesPerChunk: number;
};

export const computeChunkBounds = (
  sampleRate: number,
  minDurationMs: number,
  maxDurationMs: number,
): ChunkBounds => {
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * minDurationMs) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * maxDurationMs) / 1000),
  );
  return { minSamplesPerChunk, maxSamplesPerChunk };
};

export const buildTranscriptText = (
  finalTranscript: string,
  partialTranscript: string,
): string => {
  if (!partialTranscript) {
    return finalTranscript;
  }
  const separator = finalTranscript ? " " : "";
  return finalTranscript + separator + partialTranscript;
};

export type ChunkSenderDeps = {
  ws: () => WebSocket | null;
  drainSamples: (targetCount: number) => Float32Array;
  getPendingSampleCount: () => number;
  minSamplesPerChunk: number;
  maxSamplesPerChunk: number;
  sampleRate: number;
  convertToPayload: (chunk: Float32Array) => ArrayBuffer;
  onChunkSent: (chunk: Float32Array, payload: ArrayBuffer) => void;
  onSendError: (error: unknown) => void;
};

export const createChunkSender = (deps: ChunkSenderDeps) => {
  const sendChunk = (chunkSize: number, force: boolean): boolean => {
    let chunk = deps.drainSamples(chunkSize);
    if (force && chunk.length > 0 && chunk.length < deps.minSamplesPerChunk) {
      const padded = new Float32Array(deps.minSamplesPerChunk);
      padded.set(chunk);
      chunk = padded;
    }

    if (chunk.length === 0) {
      return false;
    }

    const socket = deps.ws();
    if (!socket) {
      return false;
    }

    try {
      const payload = deps.convertToPayload(chunk);
      socket.send(payload);
      deps.onChunkSent(chunk, payload);
      return true;
    } catch (error) {
      deps.onSendError(error);
      return false;
    }
  };

  const flushPendingSamples = (force = false): void => {
    const socket = deps.ws();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (
      deps.getPendingSampleCount() >= deps.minSamplesPerChunk ||
      (force && deps.getPendingSampleCount() > 0)
    ) {
      const chunkSize = Math.min(
        deps.getPendingSampleCount(),
        deps.maxSamplesPerChunk,
      );
      if (!sendChunk(chunkSize, force)) {
        break;
      }
    }
  };

  return { sendChunk, flushPendingSamples };
};

export type SessionTextBuffer = {
  getText: () => string;
  resetBuffers: () => void;
  drainSamples: (targetCount: number) => Float32Array;
};

export const createSessionTextBuffer = (
  finalTranscript: () => string,
  partialTranscript: () => string,
  audioBuffer: AudioBufferController,
): SessionTextBuffer => ({
  getText: () => buildTranscriptText(finalTranscript(), partialTranscript()),
  resetBuffers: () => audioBuffer.reset(),
  drainSamples: (targetCount: number) => audioBuffer.drainSamples(targetCount),
});
