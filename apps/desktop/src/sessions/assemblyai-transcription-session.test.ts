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

const createdSockets: FakeWebSocket[] = [];

/**
 * When set, the next socket closes on its first turn instead of opening, and
 * fires no `error`. That is the shape the spec allows for a failed handshake --
 * a proxy answering with a 4xx, a captive portal, a dropped SYN -- and the one
 * `close`-without-`error` path the startup promise has to survive.
 */
let closeInsteadOfOpen = false;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
    queueMicrotask(() => {
      if (closeInsteadOfOpen) {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1006 });
        return;
      }
      this.onopen?.();
    });
  }

  send(data: string | ArrayBufferView | Blob) {
    if (typeof data === "string") {
      this.sent.push(data);
    } else {
      this.sent.push(String(data));
    }
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

import {
  AssemblyAITranscriptionSession,
  startAssemblyAIStreaming,
} from "./assemblyai-transcription-session";

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
    });
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

describe("AssemblyAI streaming connection parameters", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    closeInsteadOfOpen = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the socket closes before it ever opens", async () => {
    // A promise nobody settles is the worst of the three outcomes available
    // here: `onRecordingStart` awaits it, so the session never becomes ready and
    // the caller neither starts recording nor learns that the provider is
    // unreachable. Raced against a timer rather than awaited directly, so a
    // regression reports what it did (nothing) instead of timing out the file.
    closeInsteadOfOpen = true;
    const outcome = await Promise.race([
      startAssemblyAIStreaming("test-key", 16000, [], undefined).then(
        () => "resolved",
        (error: Error) => `rejected: ${error.message}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve("STILL PENDING"), 50)),
    ]);
    expect(outcome).toBe(
      "rejected: WebSocket closed before the connection opened",
    );
  });

  it("still resolves normally when the socket closes after opening", async () => {
    // The other half of the same `onclose`: a close after a successful
    // handshake is the normal end of a session and must not reject.
    const session = await startAssemblyAIStreaming(
      "test-key",
      16000,
      [],
      undefined,
    );
    expect(session).toBeTruthy();
    const socket = createdSockets.at(-1);
    expect(() => socket?.close()).not.toThrow();
    await expect(session.finalize()).resolves.toBe("");
  });

  it("pins the universal speech model and sends keyterms when the dictionary is non-empty", async () => {
    const session = await startAssemblyAIStreaming(
      "test-key",
      16000,
      ["Soniya", "Kubernetes"],
      undefined,
    );
    const socket = createdSockets.at(-1);
    // The universal model is what supports keyterms_prompt biasing; without it
    // an account default on an older model would silently ignore the dictionary.
    expect(socket?.url).toContain("speech_model=universal-3-5-pro");
    expect(socket?.url).toContain("keyterms_prompt=");
    // The keyterms travel JSON-encoded, so decode to confirm the terms landed.
    expect(decodeURIComponent(socket?.url ?? "")).toContain("Soniya");
    session.cleanup();
  });

  it("omits keyterms_prompt when the dictionary is empty", async () => {
    const session = await startAssemblyAIStreaming(
      "test-key",
      16000,
      [],
      undefined,
    );
    const socket = createdSockets.at(-1);
    expect(socket?.url).toContain("speech_model=universal-3-5-pro");
    expect(socket?.url).not.toContain("keyterms_prompt");
    session.cleanup();
  });
});
