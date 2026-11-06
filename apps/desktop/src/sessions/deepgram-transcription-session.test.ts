import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  verbose: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => loggerMocks,
  redactQueryParamValues: (url: string) => url,
}));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/user.utils", () => ({
  loadMyEffectiveDictationLanguage: async () => "en",
}));
vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => [],
  buildProviderVocabulary: () => ({ terms: [], warning: null }),
  DEEPGRAM_KEYTERM_BUDGET: 100,
}));
vi.mock("../utils/deepgram.utils", () => ({
  buildDeepgramWebSocketUrl: () => "wss://example.test",
}));

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  constructor(_url: string, _protocols: string[]) {
    sockets.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  send(value: string | ArrayBuffer) {
    this.sent.push(value);
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
  metadata() {
    this.onmessage?.({ data: JSON.stringify({ type: "Metadata" }) });
  }
  result(text: string, final: boolean, speechFinal = false) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: text }] },
        is_final: final,
        speech_final: speechFinal,
      }),
    });
  }
}

import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";

const start = async (callback?: (text: string) => void) => {
  const session = new DeepgramTranscriptionSession("key");
  if (callback) session.setInterimResultCallback(callback);
  const started = session.onRecordingStart(16000);
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  const socket = sockets[0];
  if (!socket) throw new Error("Missing socket");
  socket.open();
  await started;
  return { session, socket };
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

describe("Deepgram finalization", () => {
  it("retains the newest recording when an older socket opens late", async () => {
    const session = new DeepgramTranscriptionSession("key");
    const first = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const second = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].open();
    await second;
    sockets[0].open();
    await first;
    expect(sockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets[1].readyState).toBe(FakeWebSocket.OPEN);
    session.cleanup();
  });

  it("does not let a finalize waiting for an old startup finalize a replacement", async () => {
    const session = new DeepgramTranscriptionSession("key");
    const first = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const pending = session.finalize({ samples: [] });
    const second = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].open();
    await second;
    sockets[0].open();
    await first;
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: ["Deepgram streaming session was not established"],
    });
    expect(sockets[1].readyState).toBe(FakeWebSocket.OPEN);
    expect(sockets[1].sent).not.toContain(
      JSON.stringify({ type: "CloseStream" }),
    );
    session.cleanup();
  });

  it("does not log transcript, metadata, error payloads, or close reasons", async () => {
    const { session, socket } = await start();
    const secret = "private dictated words and provider details";
    socket.result(secret, true);
    socket.onmessage?.({ data: secret });
    for (const type of ["Metadata", "Error", secret]) {
      socket.onmessage?.({
        data: JSON.stringify({ type, text: secret, error: secret }),
      });
    }
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

  it("settles startup when the server closes before opening", async () => {
    const session = new DeepgramTranscriptionSession("key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.close();
    const outcome = await Promise.race([
      started.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toBe("settled");
    await expect(session.finalize({ samples: [] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: ["Deepgram streaming session was not established"],
    });
  });

  it("settles a pending finalization on cleanup without a close event", async () => {
    const { session, socket } = await start();
    vi.spyOn(socket, "close").mockImplementation(() => {});
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    session.cleanup();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("cancelled")],
    });
  });

  it("completes once when summary metadata synchronously closes the socket", async () => {
    const { session, socket } = await start();
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    socket.result("hello world", true, true);
    socket.metadata();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "hello world",
      warnings: [],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("collects every in-flight utterance until CloseStream metadata arrives", async () => {
    const callback = vi.fn();
    const { session, socket } = await start(callback);
    // An unsolicited earlier metadata message is not the stop acknowledgement.
    socket.metadata();
    let settled = false;
    const pending = session.finalize({ samples: [] }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    const second = session.finalize({ samples: [] });
    socket.result("first utterance", true, true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    socket.result("second utterance", true, true);
    socket.metadata();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "first utterance second utterance",
      warnings: [],
    });
    await expect(second).resolves.toMatchObject({
      rawTranscript: "first utterance second utterance",
    });
    expect(callback.mock.calls).toEqual([
      ["first utterance"],
      ["second utterance"],
    ]);
    expect(socket.sent.filter((value) => typeof value === "string")).toEqual([
      JSON.stringify({ type: "CloseStream" }),
    ]);
  });

  it("keeps nonempty partials and calls back only for final text", async () => {
    const callback = vi.fn();
    const { session, socket } = await start(callback);
    socket.result("first", true);
    socket.result("draft", false);
    socket.result("", false);
    socket.result("", true, true);
    expect(callback).toHaveBeenCalledExactlyOnceWith("first");
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    socket.metadata();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "first draft",
    });
  });

  it("waits for metadata even after an empty speech-final result", async () => {
    const { session, socket } = await start();
    socket.result("draft words", false);
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    socket.result("", true, true);
    socket.metadata();
    const outcome = await Promise.race([
      pending,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 100),
      ),
    ]);
    expect(outcome).toMatchObject({
      rawTranscript: "draft words",
      warnings: [],
    });
  });

  it("completes finalization even when an interim consumer throws", async () => {
    const { session, socket } = await start(() => {
      throw new Error("consumer failed");
    });
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    socket.result("finished text", true, true);
    socket.metadata();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "finished text",
      warnings: [],
    });
  });

  it("rejects a partial transcript after the socket closes during recording", async () => {
    const { session, socket } = await start();
    socket.result("partial words", true);
    socket.close();
    session.writeAudioChunk(new Float32Array(1600));
    expect(socket.sent).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject(
        {
          rawTranscript: null,
          warnings: [expect.stringContaining("connection was lost")],
        },
      );
    }
  });

  it("fails and closes the stream when a live audio send throws", async () => {
    const { session, socket } = await start();
    socket.result("partial words", true);
    const send = vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("private provider detail");
    });
    session.writeAudioChunk(new Float32Array(1600));
    session.writeAudioChunk(new Float32Array(1600));
    expect(send).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("connection was lost")],
    });
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(
      "private provider detail",
    );
  });

  it("rejects finalization after a socket error during recording", async () => {
    const { session, socket } = await start();
    socket.result("partial words", true);
    socket.onerror?.(new Event("error"));
    await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("connection was lost")],
    });
  });

  it("rejects and cleans up when the termination frame cannot be sent", async () => {
    const { session, socket } = await start();
    socket.result("partial words", true);
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("send failed");
    });
    await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be finalized")],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("does not accept a partial transcript when the final buffered send fails", async () => {
    const { session, socket } = await start();
    socket.result("partial words", true);
    session.writeAudioChunk(new Float32Array(100));
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("send failed");
    });
    await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be sent")],
    });
    await expect(session.finalize({ samples: [0.1] })).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("could not be sent")],
    });
  });

  it("settles and leaves no timer when metadata arrives during the send call", async () => {
    const { session, socket } = await start();
    socket.result("complete", true);
    vi.useFakeTimers();
    vi.spyOn(socket, "send").mockImplementation(() => socket.metadata());
    await expect(session.finalize({ samples: [] })).resolves.toMatchObject({
      rawTranscript: "complete",
      warnings: [],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a partial transcript if the socket closes before metadata", async () => {
    const { session, socket } = await start();
    socket.result("first", true);
    const pending = session.finalize({ samples: [] });
    await vi.waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" })),
    );
    socket.close();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("before finalization completed")],
    });
  });

  it("rejects an incomplete transcript after its timeout", async () => {
    const { session, socket } = await start();
    socket.result("first", true);
    vi.useFakeTimers();
    const pending = session.finalize({ samples: [] });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("finalization timed out")],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
