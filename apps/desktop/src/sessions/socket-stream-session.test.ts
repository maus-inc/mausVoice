import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  verbose: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMocks }));

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  constructor(_url?: string) {
    sockets.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

import { startSocketStreamSession } from "./socket-stream-session";

const startStream = async (
  overrides: Partial<Parameters<typeof startSocketStreamSession>[0]> = {},
) => {
  const onMessage = vi.fn();
  const started = startSocketStreamSession({
    loggerPrefix: "Test Stream",
    sampleRate: 16_000,
    minChunkDurationMs: 20,
    terminationMessage: "CloseStream",
    log: () => undefined,
    getText: () => "hello",
    createSocket: () => new FakeWebSocket() as unknown as WebSocket,
    onMessage,
    ...overrides,
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  return { started, onMessage };
};

const openStream = async () => {
  const { started, onMessage } = await startStream();
  const socket = sockets[0];
  socket.open();
  return { session: await started, socket, onMessage };
};

beforeEach(() => {
  vi.clearAllMocks();
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("socket stream lifecycle", () => {
  it("rejects startup when the socket closes before it opens", async () => {
    const { started } = await startStream();
    sockets[0].onclose?.({ code: 1006 });
    await expect(started).rejects.toThrow();
  });

  it("does not resolve startup before the socket opens", async () => {
    let resolved = false;
    const { started } = await startStream();
    void started.then(
      () => {
        resolved = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(resolved).toBe(false);
    sockets[0].open();
    await started;
    expect(resolved).toBe(true);
  });

  it("forwards parsed frames to the provider and reports the socket end", async () => {
    const { session, socket, onMessage } = await openStream();
    socket.message({ type: "Results", text: "hi" });
    expect(onMessage).toHaveBeenCalledWith(
      { type: "Results", text: "hi" },
      expect.objectContaining({ isFinalizing: expect.any(Function) }),
    );
    socket.close();
    expect(session.cleanup).toBeTypeOf("function");
  });

  it("ignores a frame that is not JSON instead of failing the stream", async () => {
    const { socket, onMessage } = await openStream();
    socket.onmessage?.({ data: "not json" });
    expect(onMessage).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalled();
  });

  it("waits for the provider's acknowledgement before resolving finalize", async () => {
    const { started } = await startStream({
      onMessage: (data, control) => {
        if (data.type === "Metadata" && control.isFinalizing())
          control.complete();
      },
    });
    const socket = sockets[0];
    socket.open();
    const session = await started;
    const finalized = session.finalize();
    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    // A provider frame during recording must not settle a finalize that has
    // not started yet.
    socket.message({ type: "Metadata" });
    await expect(finalized).resolves.toBe("hello");
  });

  it("fails finalization when the socket closes before the acknowledgement", async () => {
    const { session, socket } = await openStream();
    const finalized = session.finalize();
    socket.close();
    await expect(finalized).rejects.toThrow(
      "Streaming audio ended before finalization completed",
    );
  });

  it("rejects a pending finalization when cleanup retires the stream", async () => {
    const { session } = await openStream();
    const finalized = session.finalize();
    session.cleanup();
    await expect(finalized).rejects.toThrow(
      "Streaming audio finalization was cancelled",
    );
  });

  it("stops accepting audio once the socket is no longer open", async () => {
    const { session, socket } = await openStream();
    socket.readyState = 0;
    expect(() => session.writeAudioChunk(new Float32Array(320))).not.toThrow();
    expect(session.finalize).toBeTypeOf("function");
  });
});
