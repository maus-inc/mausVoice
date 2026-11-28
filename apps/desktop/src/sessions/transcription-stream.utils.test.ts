import { describe, expect, it, vi } from "vitest";
import { createAudioChunkBuffer } from "./transcription-stream.utils";

describe("createAudioChunkBuffer", () => {
  const config = {
    sampleRate: 16000,
    minChunkDurationMs: 100, // 1600 samples
    maxChunkDurationMs: 200, // 3200 samples
    loggerPrefix: "test",
  };

  it("buffers chunks until minSamplesPerChunk is reached", () => {
    const sentData: ArrayBuffer[] = [];
    const mockWs = {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn((data: ArrayBuffer) => {
        sentData.push(data);
      }),
    } as unknown as WebSocket;

    const buffer = createAudioChunkBuffer(() => mockWs, config);

    // Push 800 samples (less than min 1600)
    buffer.push(new Float32Array(800));
    buffer.flush();

    expect(sentData).toHaveLength(0);
    expect(buffer.pendingSampleCount()).toBe(800);

    // Push another 800 samples -> 1600 samples reached
    buffer.push(new Float32Array(800));
    buffer.flush();

    expect(sentData).toHaveLength(1);
    expect(buffer.pendingSampleCount()).toBe(0);
    expect(buffer.sentChunkCount()).toBe(1);
  });

  it("pads and flushes when forced even if below minSamplesPerChunk", () => {
    const sentData: ArrayBuffer[] = [];
    const mockWs = {
      readyState: 1,
      send: vi.fn((data: ArrayBuffer) => {
        sentData.push(data);
      }),
    } as unknown as WebSocket;

    const buffer = createAudioChunkBuffer(() => mockWs, config);

    buffer.push(new Float32Array(500));
    buffer.flush(true);

    expect(sentData).toHaveLength(1);
    // Padded to minSamplesPerChunk (1600 samples * 2 bytes = 3200 bytes)
    expect(sentData[0].byteLength).toBe(3200);
    expect(buffer.pendingSampleCount()).toBe(0);
  });

  it("restores unpadded chunk to buffer when socket send throws", () => {
    let shouldFail = true;
    const sentData: ArrayBuffer[] = [];
    const mockWs = {
      readyState: 1,
      send: vi.fn((data: ArrayBuffer) => {
        if (shouldFail) {
          throw new Error("WebSocket send failed");
        }
        sentData.push(data);
      }),
    } as unknown as WebSocket;

    const buffer = createAudioChunkBuffer(() => mockWs, config);

    buffer.push(new Float32Array(1600));
    expect(buffer.pendingSampleCount()).toBe(1600);

    buffer.flush();
    // Failed to send, samples restored
    expect(buffer.pendingSampleCount()).toBe(1600);
    expect(buffer.sentChunkCount()).toBe(0);

    // Socket recovers
    shouldFail = false;
    buffer.flush();
    expect(buffer.pendingSampleCount()).toBe(0);
    expect(buffer.sentChunkCount()).toBe(1);
    expect(sentData).toHaveLength(1);
  });

  it("restores unpadded chunk to buffer when a forced padded send throws", () => {
    let shouldFail = true;
    const sentData: ArrayBuffer[] = [];
    const mockWs = {
      readyState: 1,
      send: vi.fn((data: ArrayBuffer) => {
        if (shouldFail) {
          throw new Error("WebSocket send failed");
        }
        sentData.push(data);
      }),
    } as unknown as WebSocket;

    const buffer = createAudioChunkBuffer(() => mockWs, config);

    // Push 500 samples (< min 1600)
    const originalSamples = new Float32Array(500);
    originalSamples[0] = 0.5;
    originalSamples[499] = 0.25;
    buffer.push(originalSamples);
    expect(buffer.pendingSampleCount()).toBe(500);

    // Force flush fails on send
    buffer.flush(true);
    // Buffer must retain the original 500 unpadded samples, not the 1600 padded ones
    expect(buffer.pendingSampleCount()).toBe(500);
    expect(buffer.sentChunkCount()).toBe(0);

    // Socket recovers, retry force flush
    shouldFail = false;
    buffer.flush(true);
    expect(buffer.pendingSampleCount()).toBe(0);
    expect(buffer.sentChunkCount()).toBe(1);
    expect(sentData).toHaveLength(1);
    expect(sentData[0].byteLength).toBe(3200);
  });

  it("does nothing when socket is null or not open", () => {
    const mockWs = {
      readyState: 0, // CONNECTING
      send: vi.fn(),
    } as unknown as WebSocket;

    const buffer = createAudioChunkBuffer(() => mockWs, config);
    buffer.push(new Float32Array(2000));
    buffer.flush();

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(buffer.pendingSampleCount()).toBe(2000);
  });

  it("clears all pending samples on reset", () => {
    const buffer = createAudioChunkBuffer(() => null, config);
    buffer.push(new Float32Array(2000));
    expect(buffer.pendingSampleCount()).toBe(2000);

    buffer.reset();
    expect(buffer.pendingSampleCount()).toBe(0);
  });
});
