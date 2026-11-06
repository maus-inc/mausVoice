import { describe, expect, it, vi } from "vitest";
import { getLogger } from "../utils/log.utils";
import {
  createAudioChunkBuffer,
  enqueueStreamingAudio,
  createWebSocketStartup,
  WEBSOCKET_STARTUP_TIMEOUT_MS,
} from "./transcription-stream.utils";

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
    expect(buffer.hasSendFailure()).toBe(true);

    // Socket recovers
    shouldFail = false;
    buffer.flush();
    expect(buffer.pendingSampleCount()).toBe(0);
    expect(buffer.sentChunkCount()).toBe(1);
    expect(sentData).toHaveLength(1);
  });

  it("rejects a stalled WebSocket instead of growing its browser send queue", () => {
    const mockWs = {
      readyState: 1,
      bufferedAmount: 8 * 1024 * 1024,
      send: vi.fn(),
    } as unknown as WebSocket;
    const buffer = createAudioChunkBuffer(() => mockWs, config);
    buffer.push(new Float32Array(1600));
    buffer.flush();
    expect(mockWs.send).not.toHaveBeenCalled();
    expect(buffer.hasSendFailure()).toBe(true);
    expect(buffer.pendingSampleCount()).toBe(1600);
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

describe("enqueueStreamingAudio", () => {
  it("queues audio before flushing without forcing a partial chunk", () => {
    const chunk = new Float32Array([1, 2]);
    const buffer = {
      push: vi.fn(),
      flush: vi.fn(),
      reset: vi.fn(),
      pendingSampleCount: vi.fn(),
    };
    enqueueStreamingAudio(buffer, chunk, "provider");
    expect(buffer.push).toHaveBeenCalledWith(chunk);
    expect(buffer.flush).toHaveBeenCalledWith(false);
    expect(buffer.push.mock.invocationCallOrder[0]).toBeLessThan(
      buffer.flush.mock.invocationCallOrder[0],
    );
  });

  it("logs and absorbs a buffer error", () => {
    const error = new Error("broken buffer");
    const logger = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);
    const buffer = {
      push: vi.fn(() => {
        throw error;
      }),
      flush: vi.fn(),
      reset: vi.fn(),
      pendingSampleCount: vi.fn(),
    };
    expect(enqueueStreamingAudio(buffer, new Float32Array(), "provider")).toBe(
      false,
    );
    expect(logger).toHaveBeenCalledWith("[provider] Error sending audio chunk");
    expect(buffer.flush).not.toHaveBeenCalled();
    logger.mockRestore();
  });
});

describe("WebSocket startup", () => {
  it("settles a close-before-open exactly once and cleans up", () => {
    const cleanup = vi.fn();
    const reject = vi.fn();
    const startup = createWebSocketStartup("test", cleanup, vi.fn(), reject);
    expect(startup.closedBeforeOpen()).toBe(true);
    expect(startup.closedBeforeOpen()).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "WebSocket closed before the connection opened",
      }),
    );
  });
  it("cleans up errors and marks startup settled before a synchronous close callback", () => {
    const reject = vi.fn();
    let startup: ReturnType<typeof createWebSocketStartup>;
    const cleanup = vi.fn(() => expect(startup.closedBeforeOpen()).toBe(false));
    startup = createWebSocketStartup("test", cleanup, vi.fn(), reject);
    startup.error(new Error("connection lost"));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "WebSocket connection failed" }),
    );
  });
  it("rejects setup errors and ignores a later stale open event", () => {
    const cleanup = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const startup = createWebSocketStartup("test", cleanup, resolve, reject);
    startup.open(() => {
      throw new Error("setup failed");
    });
    const staleSetup = vi.fn();
    startup.open(staleSetup);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "WebSocket connection failed" }),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(staleSetup).not.toHaveBeenCalled();
  });
  it("does not resolve when the connection fails synchronously during setup", () => {
    const cleanup = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const startup = createWebSocketStartup("test", cleanup, resolve, reject);
    startup.open(() => {
      startup.error(new Error("setup interrupted"));
      return {};
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("times out a silent handshake and ignores a late open", () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const resolve = vi.fn();
      const reject = vi.fn();
      const startup = createWebSocketStartup("test", cleanup, resolve, reject);
      vi.advanceTimersByTime(WEBSOCKET_STARTUP_TIMEOUT_MS);
      startup.open(() => ({}));
      expect(cleanup).toHaveBeenCalledOnce();
      expect(reject).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "WebSocket connection failed" }),
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a close after opening as a normal session close", () => {
    const cleanup = vi.fn();
    const reject = vi.fn();
    const startup = createWebSocketStartup("test", cleanup, vi.fn(), reject);
    startup.open(() => ({}));
    expect(startup.closedBeforeOpen()).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});
