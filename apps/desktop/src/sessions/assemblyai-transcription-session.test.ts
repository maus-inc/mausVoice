import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const createdSockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(_url: string) {
    createdSockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe("AssemblyAITranscriptionSession finalize contract", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the accumulated turn transcript instead of 'session was not established'", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets.at(-1);
    expect(socket).toBeTruthy();

    // Server delivers a completed turn.
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "Turn",
        end_of_turn: true,
        turn_order: 0,
        transcript: "hello world",
      }),
    });
    await flushMicrotasks();

    const finalizePromise = session.finalize({
      samples: [],
      sampleRate: 16000,
    } as never);
    await flushMicrotasks();

    // The Terminate frame must have gone out over the still-open socket.
    expect(socket?.sent.some((raw) => raw.includes("Terminate"))).toBe(true);

    // Close the socket so finalize resolves without the 2 s timeout.
    socket?.close();
    const result = await finalizePromise;

    expect(result.warnings).toEqual([]);
    expect(result.rawTranscript).toBe("hello world");
    expect(result.metadata.transcriptionMode).toBe("api");
  });
});
