import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;

const importWithLiveSdkMock = async ({
  deleteResult = true,
  initialSessionId = "live-1",
  sessionIdPromise = Promise.resolve("live-1"),
}: {
  deleteResult?: boolean;
  initialSessionId?: string | null;
  sessionIdPromise?: Promise<string>;
} = {}) => {
  const listeners = new Map<string, Listener[]>();
  const fakeSession = {
    sessionId: initialSessionId,
    getSessionId: vi.fn(() => sessionIdPromise),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fakeSession;
    }),
    once: vi.fn((event: string, listener: Listener) => {
      const onceListener = (payload: unknown) => {
        listener(payload);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((item) => item !== onceListener),
        );
      };
      listeners.set(event, [...(listeners.get(event) ?? []), onceListener]);
      return fakeSession;
    }),
    sendAudio: vi.fn(),
    stopRecording: vi.fn(),
    endSession: vi.fn(),
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(payload);
    }
  };
  fakeSession.stopRecording.mockImplementation(() => {
    queueMicrotask(() => emit("ended", { code: 1000, reason: "complete" }));
  });

  const startSession = vi.fn(() => fakeSession);
  const deleteSession = vi.fn().mockResolvedValue(deleteResult);
  const clientOptions: unknown[] = [];
  const liveV2 = vi.fn(() => ({
    startSession,
    delete: deleteSession,
  }));

  vi.resetModules();
  vi.doMock("@gladiaio/sdk", () => ({
    GladiaClient: class MockGladiaClient {
      constructor(options: unknown) {
        clientOptions.push(options);
      }
      liveV2 = liveV2;
    },
  }));

  const module = await import("./gladia.utils");
  return {
    ...module,
    fakeSession,
    emit,
    startSession,
    deleteSession,
    clientOptions,
  };
};

afterEach(() => {
  vi.doUnmock("@gladiaio/sdk");
  vi.restoreAllMocks();
});

describe("createGladiaStreamingSession", () => {
  it("rejects a blank key before constructing an SDK client", async () => {
    const { createGladiaStreamingSession, clientOptions, startSession } =
      await importWithLiveSdkMock();

    expect(() =>
      createGladiaStreamingSession({
        apiKey: "  ",
        sampleRate: 16000,
        language: "auto",
      }),
    ).toThrow("API key is required");
    expect(clientOptions).toEqual([]);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("sends PCM, emits final utterances once, and prefers post-final text", async () => {
    const {
      createGladiaStreamingSession,
      emit,
      fakeSession,
      startSession,
      deleteSession,
      clientOptions,
    } = await importWithLiveSdkMock();
    const onFinalSegment = vi.fn();
    const onReady = vi.fn();
    const onConnectionInterrupted = vi.fn();
    const session = createGladiaStreamingSession({
      apiKey: " key ",
      sampleRate: 16000,
      language: "en-US",
      model: "solaria-1",
      onReady,
      onConnectionInterrupted,
      onFinalSegment,
    });

    expect(clientOptions[0]).toMatchObject({
      apiKey: "key",
      httpRetry: { maxAttempts: 3 },
      wsRetry: { maxAttemptsPerConnection: 3, maxConnections: 4 },
    });
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "solaria-1",
        encoding: "wav/pcm",
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
        language_config: { languages: ["en"], code_switching: false },
      }),
    );

    emit("started", { url: "wss://api.gladia.io/v2/live?token=temporary" });
    expect(onReady).not.toHaveBeenCalled();
    emit("connected", { attempt: 1 });
    expect(onReady).toHaveBeenCalledOnce();
    emit("connecting", { attempt: 2 });
    expect(onConnectionInterrupted).toHaveBeenCalledOnce();
    const audio = new ArrayBuffer(8);
    session.sendAudio(audio);
    expect(fakeSession.sendAudio).toHaveBeenCalledWith(audio);

    emit("message", {
      type: "transcript",
      data: {
        id: "one",
        is_final: false,
        utterance: { text: "hello" },
      },
    });
    emit("message", {
      type: "transcript",
      data: {
        id: "one",
        is_final: true,
        utterance: { text: "hello world" },
      },
    });
    emit("message", {
      type: "transcript",
      data: {
        id: "one",
        is_final: true,
        utterance: { text: "duplicate" },
      },
    });
    emit("message", {
      type: "post_final_transcript",
      data: { transcription: { full_transcript: "Hello world." } },
    });

    const firstFinalize = session.finalize();
    const secondFinalize = session.finalize();
    expect(secondFinalize).toBe(firstFinalize);
    await expect(firstFinalize).resolves.toBe("Hello world.");
    expect(onFinalSegment).toHaveBeenCalledOnce();
    expect(onFinalSegment).toHaveBeenCalledWith("hello world");
    expect(fakeSession.stopRecording).toHaveBeenCalledOnce();
    session.sendAudio(new ArrayBuffer(4));
    expect(fakeSession.sendAudio).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith("live-1");
  });

  it("rejects malformed messages and bounds provider warning growth", async () => {
    const { createGladiaStreamingSession, emit } =
      await importWithLiveSdkMock();
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
    });

    expect(() =>
      emit("message", { type: "transcript", data: null }),
    ).not.toThrow();
    for (let index = 0; index < 100; index++) {
      emit("error", new Error(`connection failure ${index}`));
    }

    expect(session.getWarnings()).toHaveLength(50);
    expect(session.getWarnings()).toContain(
      "Gladia returned a malformed transcript message.",
    );
    expect(session.getWarnings()).toContain(
      "Additional Gladia live-session warnings were omitted.",
    );
  });

  it("rejects untrusted WebSocket origins without exposing the URL", async () => {
    const { createGladiaStreamingSession, emit, fakeSession } =
      await importWithLiveSdkMock();
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
    });

    emit("started", { url: "wss://api.gladia.io.evil.test/live?token=secret" });
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
    expect(session.getWarnings()).toEqual([
      "Gladia returned an untrusted WebSocket endpoint.",
    ]);
    expect(session.getWarnings().join(" ")).not.toContain("secret");

    emit(
      "error",
      new Error("connect failed at wss://api.gladia.io/live?token=secret"),
    );
    expect(session.getWarnings().join(" ")).not.toContain("secret");
    expect(session.getWarnings().join(" ")).toContain(
      "[Gladia WebSocket endpoint]",
    );
    emit("ended", {
      code: 1006,
      reason:
        "closed at wss://api.gladia.io/live?token=secret; authorization=top-secret",
    });
    expect(session.getWarnings().join(" ")).not.toContain("secret");
    expect(session.getWarnings().join(" ")).toContain(
      "authorization=[redacted]",
    );
  });

  it("does not stop before the temporary WebSocket endpoint is validated", async () => {
    const { createGladiaStreamingSession, emit, fakeSession } =
      await importWithLiveSdkMock();
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
      finalizeTimeoutMs: 100,
    });

    const finalizing = session.finalize();
    expect(fakeSession.stopRecording).not.toHaveBeenCalled();
    emit("started", { url: "wss://api.gladia.io/v2/live?token=temporary" });

    await expect(finalizing).resolves.toBe("");
    expect(fakeSession.stopRecording).toHaveBeenCalledOnce();
  });

  it("bounds initialization when no endpoint can be validated", async () => {
    const { createGladiaStreamingSession, fakeSession } =
      await importWithLiveSdkMock();
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
      finalizeTimeoutMs: 1,
    });

    await expect(session.finalize()).resolves.toBe("");
    expect(fakeSession.stopRecording).not.toHaveBeenCalled();
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
    expect(session.getWarnings()).toContain(
      "Gladia initialization timed out before endpoint validation.",
    );
  });

  it("bounds finalization and marks partial-only fallback text", async () => {
    const { createGladiaStreamingSession, emit, fakeSession, deleteSession } =
      await importWithLiveSdkMock();
    fakeSession.stopRecording.mockImplementation(() => undefined);
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
      finalizeTimeoutMs: 1,
    });
    emit("started", { url: "wss://api.gladia.io/v2/live?token=temporary" });
    emit("message", {
      type: "transcript",
      data: {
        id: "one",
        is_final: false,
        utterance: { text: "best effort" },
      },
    });

    await expect(session.finalize()).resolves.toBe("best effort");
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(session.getWarnings()).toEqual(
      expect.arrayContaining([
        "Gladia finalization timed out; using finalized text received so far.",
        "Gladia returned only a partial transcript before the session ended.",
      ]),
    );
  });

  it("makes cleanup and remote deletion idempotent", async () => {
    const { createGladiaStreamingSession, fakeSession, deleteSession } =
      await importWithLiveSdkMock();
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
    });

    session.cleanup();
    session.cleanup();
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledOnce());
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
    session.sendAudio(new ArrayBuffer(4));
    expect(fakeSession.sendAudio).not.toHaveBeenCalled();
  });

  it("deletes a late initialization ID captured before cleanup aborts", async () => {
    let resolveSessionId!: (sessionId: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });
    const { createGladiaStreamingSession, deleteSession } =
      await importWithLiveSdkMock({
        initialSessionId: null,
        sessionIdPromise,
      });
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
    });

    session.cleanup();
    expect(deleteSession).not.toHaveBeenCalled();
    resolveSessionId("late-live-id");

    await vi.waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith("late-live-id"),
    );
  });

  it("surfaces live deletion failures without dropping transcript text", async () => {
    const { createGladiaStreamingSession, emit } = await importWithLiveSdkMock({
      deleteResult: false,
    });
    const session = createGladiaStreamingSession({
      apiKey: "key",
      sampleRate: 16000,
      language: "auto",
    });
    emit("started", { url: "wss://api.gladia.io/v2/live?token=temporary" });
    emit("message", {
      type: "transcript",
      data: {
        id: "one",
        is_final: true,
        utterance: { text: "kept" },
      },
    });

    await expect(session.finalize()).resolves.toBe("kept");
    expect(session.getWarnings()).toContain(
      "Gladia live data deletion was not acknowledged.",
    );
  });
});
