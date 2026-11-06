import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  stopwatch: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMocks }));

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
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;

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

  termination() {
    this.onmessage?.({ data: JSON.stringify({ type: "Termination" }) });
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
    vi.clearAllMocks();
    createdSockets.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retires an earlier pending stream when a new recording starts", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    const first = session.onRecordingStart(16000);
    const second = session.onRecordingStart(16000);
    await Promise.all([first, second]);
    expect(createdSockets).toHaveLength(2);
    expect(createdSockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(createdSockets[1].readyState).toBe(FakeWebSocket.OPEN);
    session.cleanup();
  });

  it("retires a startup that finishes after cleanup", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    session.cleanup();
    await started;
    expect(createdSockets[0].readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("does not log untrusted message fields or socket close reasons", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    const secret = "private transcript and provider details";
    socket.onmessage?.({ data: secret });
    socket.onmessage?.({
      data: JSON.stringify({
        type: secret,
        turn_order: secret,
        end_of_turn: secret,
        transcript: secret,
      }),
    });
    socket.onclose?.({ code: 1000, reason: secret });
    expect(
      Object.values(loggerMocks)
        .flatMap((log) => log.mock.calls)
        .flat()
        .map(String)
        .join(" "),
    ).not.toContain("private");
    session.cleanup();
  });

  it("settles a pending finalization on cleanup without a close event", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    vi.spyOn(socket, "close").mockImplementation(() => {});
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "Terminate" })),
    );
    session.cleanup();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("cancelled")],
    });
  });

  it("keeps the latest partial from the first turn", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets.at(-1);
    for (const transcript of ["one", "one two"]) {
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "Turn",
          end_of_turn: false,
          turn_order: 0,
          transcript,
        }),
      });
    }
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    socket?.termination();
    await expect(pending).resolves.toMatchObject({ rawTranscript: "one two" });
  });

  it("does not regress a newer partial when an older turn arrives late", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets.at(-1);
    for (const [turn_order, transcript] of [
      [1, "new words"],
      [0, "old words"],
    ] as const) {
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "Turn",
          end_of_turn: false,
          turn_order,
          transcript,
        }),
      });
    }
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    socket?.termination();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "new words",
    });
  });

  it("clears finalized partial text even when an interim consumer throws", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    session.setInterimResultCallback(() => {
      throw new Error("consumer failed");
    });
    await session.onRecordingStart(16000);
    const socket = createdSockets.at(-1);
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "Turn",
        end_of_turn: false,
        turn_order: 1,
        transcript: "draft",
      }),
    });
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "Turn",
        end_of_turn: true,
        turn_order: 1,
        transcript: "finished",
      }),
    });
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    socket?.termination();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "finished",
      warnings: [],
    });
  });

  it("rejects a partial transcript after a premature socket close", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    socket.onmessage?.({
      data: JSON.stringify({
        type: "Turn",
        end_of_turn: true,
        turn_order: 0,
        transcript: "partial words",
      }),
    });
    socket.close();
    session.writeAudioChunk(new Float32Array(1600));
    expect(socket.sent).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await expect(
        session.finalize({ samples: [0.1], sampleRate: 16000 }),
      ).resolves.toMatchObject({
        rawTranscript: null,
        warnings: [expect.stringContaining("connection was lost")],
      });
    }
  });

  it("fails and closes the stream when a live audio send throws", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    const send = vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("private provider detail");
    });
    session.writeAudioChunk(new Float32Array(1600));
    session.writeAudioChunk(new Float32Array(1600));
    expect(send).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    await expect(
      session.finalize({ samples: [0.1], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("connection was lost")],
    });
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(
      "private provider detail",
    );
  });

  it("rejects finalization after a socket error during recording", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    socket.onerror?.(new Event("error"));
    await expect(
      session.finalize({ samples: [0.1], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("connection was lost")],
    });
  });

  it("rejects and cleans up when the termination frame cannot be sent", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("send failed");
    });
    await expect(
      session.finalize({ samples: [0.1], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be finalized")],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("rejects when the final buffered audio cannot be sent", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    session.writeAudioChunk(new Float32Array(100));
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("send failed");
    });
    await expect(
      session.finalize({ samples: [0.1], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be sent")],
    });
    await expect(
      session.finalize({ samples: [0.1], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be sent")],
    });
  });

  it("collects all turns until the Termination acknowledgement", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    let settled = false;
    const pending = session
      .finalize({ samples: [], sampleRate: 16000 })
      .then((result) => {
        settled = true;
        return result;
      });
    const second = session.finalize({ samples: [], sampleRate: 16000 });
    for (const [turn_order, transcript] of [
      [0, "first"],
      [1, "second"],
    ] as const) {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "Turn",
          turn_order,
          transcript,
          end_of_turn: true,
        }),
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    }
    socket.termination();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "first second",
      warnings: [],
    });
    await expect(second).resolves.toMatchObject({
      rawTranscript: "first second",
    });
    expect(
      socket.sent.filter((value) => value.includes("Terminate")),
    ).toHaveLength(1);
  });

  it("rejects when the socket closes without the Termination acknowledgement", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    const pending = session.finalize({ samples: [0.1], sampleRate: 16000 });
    socket.close();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("before finalization completed")],
    });
  });

  it("rejects an incomplete transcript when termination times out", async () => {
    const session = new AssemblyAITranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    const socket = createdSockets[0];
    vi.useFakeTimers();
    const pending = session.finalize({ samples: [0.1], sampleRate: 16000 });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("finalization timed out")],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    vi.useRealTimers();
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

    // The final Termination message acknowledges all preceding turns.
    socket?.termination();
    const result = await finalizePromise;

    expect(result.warnings).toEqual([]);
    expect(result.rawTranscript).toBe("hello world");
    expect(result.metadata.transcriptionMode).toBe("api");
  });
});

describe("AssemblyAI streaming connection parameters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdSockets.length = 0;
    closeInsteadOfOpen = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("reports a socket that closes after opening but before finalization", async () => {
    const session = await startAssemblyAIStreaming(
      "test-key",
      16000,
      [],
      undefined,
    );
    expect(session).toBeTruthy();
    const socket = createdSockets.at(-1);
    expect(() => socket?.close()).not.toThrow();
    await expect(session.finalize()).rejects.toThrow(
      "Streaming audio connection was lost",
    );
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
