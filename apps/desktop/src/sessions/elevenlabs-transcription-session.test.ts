import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const loggerMocks = vi.hoisted(() => ({ verbose: vi.fn(), error: vi.fn() }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: loggerMocks.verbose,
    warning: vi.fn(),
    error: loggerMocks.error,
    stopwatch: vi.fn(),
  }),
  redactQueryParamValues: (url: string) => url,
}));

vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ token: "single-use-token" }),
    text: async () => "",
  })),
}));

vi.mock("../store", () => ({ getAppState: () => ({}) }));

vi.mock("../utils/user.utils", () => ({
  getMyUserPreferences: () => ({}),
}));

// The pending queue is module-private, so it is observed through the one value
// that tracks it. `drainSamples` receives the same counter object the session
// mutates on every accepted chunk, so holding a reference to it here is a
// read-only window onto how much audio is being held -- not a way to change it.
const queueCounters: { value: number }[] = [];
vi.mock("./audio-buffer.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audio-buffer.utils")>();
  return {
    ...actual,
    drainSamples: (
      pending: Float32Array[],
      counter: { value: number },
      target: number,
    ) => {
      queueCounters.push(counter);
      return actual.drainSamples(pending, counter, target);
    },
  };
});

const createdSockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  url: string;
  sent: string[] = [];
  failuresRemaining = 0;
  closeOnSendFailure = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string | ArrayBufferView | Blob) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      if (this.closeOnSendFailure) this.close();
      throw new Error("send failed");
    }
    if (typeof data === "string") this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";

/** 20 ms of 16 kHz audio: exactly one minimum-sized chunk. */
const chunk = () => new Float32Array(320).fill(0.5);

/**
 * The socket the session most recently constructed.
 *
 * Every caller has just waited for `createdSockets` to grow, so an empty read
 * here means the wait timed out. That was `createdSockets.at(-1)!`, which handed
 * the next line `undefined` and surfaced as a `TypeError` on `.open()` naming
 * neither the timeout nor the socket.
 */
const latestSocket = (): FakeWebSocket => {
  const socket = createdSockets.at(-1);
  if (!socket) {
    throw new Error("Expected the session to have constructed a WebSocket");
  }
  return socket;
};

/**
 * The sample counter the most recently constructed queue writes to.
 *
 * No queue yet is a real state -- the session has not created one -- and reads
 * as 0 retained samples. What is not a real state is a non-empty list whose
 * last entry has gone missing, which is what the previous `at(-1)!.value`
 * asserted away with a forbidden non-null assertion.
 */
const latestQueueValue = (): number => {
  if (queueCounters.length === 0) return 0;
  const counter = queueCounters.at(-1);
  if (!counter) {
    throw new Error(
      `Expected a sample counter in a list of ${queueCounters.length}`,
    );
  }
  return counter.value;
};

const startSession = async (sampleRate = 16000) => {
  const session = new ElevenLabsTranscriptionSession("test-key");
  const started = session.onRecordingStart(sampleRate);
  await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
  const socket = latestSocket();
  socket.open();
  await started;
  return { session, socket };
};

/** Samples currently held in the pending queue. */
const retainedSamples = () => latestQueueValue();

describe("ElevenLabs audio retention across a socket close", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    queueCounters.length = 0;
    loggerMocks.verbose.mockClear();
    loggerMocks.error.mockClear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not read or log a credential-bearing token error body", async () => {
    const { secureFetch } = await import("../utils/secure-fetch.utils");
    const text = vi.fn(async () => "key: super-secret");
    vi.mocked(secureFetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text,
    } as unknown as Response);
    const session = new ElevenLabsTranscriptionSession("super-secret");
    await session.onRecordingStart(16000);
    expect(text).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerMocks.verbose.mock.calls)).not.toContain(
      "super-secret",
    );
    expect(createdSockets).toHaveLength(0);
  });

  it("does not log an untrusted token transport exception", async () => {
    const { secureFetch } = await import("../utils/secure-fetch.utils");
    vi.mocked(secureFetch).mockRejectedValueOnce(
      new Error("private dictation and secret token"),
    );
    const session = new ElevenLabsTranscriptionSession("test-key");
    await session.onRecordingStart(16000);
    expect(loggerMocks.error).toHaveBeenCalledWith(
      "[ElevenLabs] Failed to start streaming",
    );
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(
      "private dictation",
    );
    expect(createdSockets).toHaveLength(0);
  });

  it.each([undefined, "", "   ", 42])(
    "rejects an invalid single-use token (%s) without opening a socket",
    async (token) => {
      const { secureFetch } = await import("../utils/secure-fetch.utils");
      vi.mocked(secureFetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token }),
      } as unknown as Response);
      const session = new ElevenLabsTranscriptionSession("test-key");
      const started = session.onRecordingStart(16000);
      const outcome = await Promise.race([
        started.then(() => "settled"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 100),
        ),
      ]);
      if (outcome === "pending") createdSockets.at(-1)?.close();
      expect(outcome).toBe("settled");
      expect(createdSockets).toHaveLength(0);
      expect(loggerMocks.error).toHaveBeenCalledWith(
        "[ElevenLabs] Failed to start streaming",
      );
    },
  );

  it("does not log transcript or provider payload contents", async () => {
    const { socket } = await startSession();
    const secret = "private transcript and credential-shaped server details";
    for (const message_type of [
      "partial_transcript",
      "committed_transcript",
      "session_started",
      "error",
    ]) {
      socket.onmessage?.({
        data: JSON.stringify({ message_type, text: secret, details: secret }),
      });
    }
    socket.onmessage?.({ data: secret });
    socket.onmessage?.({ data: JSON.stringify({ message_type: secret }) });
    socket.onclose?.({ code: 1000, reason: secret });
    expect(JSON.stringify(loggerMocks.verbose.mock.calls)).not.toContain(
      secret,
    );
    expect(
      loggerMocks.error.mock.calls.flat().map(String).join(" "),
    ).not.toContain("private");
  });

  it("retires a late startup instead of replacing a newer stream", async () => {
    const session = new ElevenLabsTranscriptionSession("test-key");
    const callback = vi.fn();
    session.setInterimResultCallback(callback);
    const firstStart = session.onRecordingStart(16000);
    const secondStart = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets).toHaveLength(2));
    const [first, second] = createdSockets;
    second.open();
    await secondStart;
    first.open();
    await firstStart;
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    first.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "stale",
      }),
    });
    expect(callback).not.toHaveBeenCalled();
    session.writeAudioChunk(chunk());
    expect(second.sent).toHaveLength(1);
    session.cleanup();
  });

  it("retires a startup that opens after cleanup", async () => {
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets).toHaveLength(1));
    session.cleanup();
    const socket = latestSocket();
    socket.open();
    await started;
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    await expect(
      session.finalize({ samples: [], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      warnings: ["ElevenLabs streaming session was not established"],
    });
  });

  it("settles startup when the socket closes before opening", async () => {
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    latestSocket().close();
    const outcome = await Promise.race([
      started.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toBe("settled");
    await expect(
      session.finalize({ samples: [], sampleRate: 16000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: ["ElevenLabs streaming session was not established"],
    });
  });

  it("fails immediately if the socket closes during finalization", async () => {
    const { session, socket } = await startSession();
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "partial_transcript",
        text: "partial",
      }),
    });
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    socket.close();
    const outcome = await Promise.race([
      pending,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs connection closed before finalization",
      ],
    });
  });

  it("finishes a committed transcript even if an interim consumer throws", async () => {
    const session = new ElevenLabsTranscriptionSession("test-key");
    session.setInterimResultCallback(() => {
      throw new Error("consumer failed");
    });
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    const socket = latestSocket();
    socket.open();
    await started;
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "complete",
      }),
    });
    const outcome = await Promise.race([
      pending,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toMatchObject({ rawTranscript: "complete", warnings: [] });
  });

  it("sends queued audio once the socket is open", async () => {
    // The control: the queue really is a queue, and it really does drain, so a
    // retained-samples assertion below is measuring retention and not a queue
    // that never held anything.
    const { session, socket } = await startSession();
    expect(retainedSamples()).toBe(0);
    session.writeAudioChunk(chunk());
    expect(socket.sent.length).toBeGreaterThan(0);
    expect(retainedSamples()).toBe(0);
  });

  it("has no writer at all while the socket is connecting", async () => {
    // What the comment above `pendingChunks.push` used to promise -- that a
    // chunk arriving while the socket is CONNECTING is queued and replayed by
    // `onopen` -- describes a state this class cannot reach. The stream session
    // is handed out from `ws.onopen` and not before, so while the handshake is
    // in flight `BaseApiTranscriptionSession.writeAudioChunk` has no session to
    // forward to and the audio is dropped. Pinned because the test that used to
    // cover this window was titled "keeps audio queued while the socket is still
    // connecting" and never wrote a chunk inside it.
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    const socket = latestSocket();
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    session.writeAudioChunk(chunk());

    socket.open();
    await started;
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    // Nothing was held across the handshake, so `onopen`'s drain had nothing to
    // send. The write after the open does go out, which is what makes the empty
    // `sent` above a fact about the connecting window rather than a queue that
    // never worked in the first place.
    expect(socket.sent).toEqual([]);
    session.writeAudioChunk(chunk());
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  it("preserves resampled duration across chunk boundaries and flushes the tail", async () => {
    const { session, socket } = await startSession(32000);
    for (let i = 0; i < 32; i++)
      session.writeAudioChunk(new Float32Array(1000).fill(0.25));
    const pending = session.finalize({ samples: [], sampleRate: 32000 });
    await Promise.resolve();
    const messages = socket.sent.map((message) => JSON.parse(message));
    expect(messages.at(-1).commit).toBe(true);
    const sampleCount = messages.reduce(
      (total, message) =>
        total + Buffer.from(message.audio_base_64, "base64").length / 2,
      0,
    );
    expect(sampleCount).toBe(24000);
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "done",
      }),
    });
    await expect(pending).resolves.toMatchObject({ rawTranscript: "done" });
  });

  it("fails on provider error rather than returning partial text", async () => {
    const { session, socket } = await startSession();
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "partial_transcript",
        text: "partial",
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "queue_overflow",
        error: "private",
      }),
    });
    const result = await session.finalize({ samples: [], sampleRate: 16000 });
    expect(result).toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs reported a streaming error",
      ],
    });
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(
      "private",
    );
  });

  it("fails when the browser send queue is stalled", async () => {
    const { session, socket } = await startSession();
    socket.bufferedAmount = 8 * 1024 * 1024;
    session.writeAudioChunk(chunk());
    expect(socket.sent).toHaveLength(0);
    const result = await session.finalize({ samples: [], sampleRate: 16000 });
    expect(result).toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs audio queue limit reached",
      ],
    });
  });

  it("rejects a pending finalization when the provider reports an error", async () => {
    const { session, socket } = await startSession();
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    socket.onmessage?.({
      data: JSON.stringify({ message_type: "transcriber_error" }),
    });
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs reported a streaming error",
      ],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("settles a pending finalization when the session is cancelled", async () => {
    const { session } = await startSession();
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    session.cleanup();
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs stream was cancelled",
      ],
    });
  });

  it("copies queued audio so caller mutations cannot alter a retry", async () => {
    const { session, socket } = await startSession();
    socket.failuresRemaining = 1;
    const audio = chunk();
    session.writeAudioChunk(audio);
    audio.fill(0);
    session.writeAudioChunk(chunk());
    const data = Buffer.from(
      JSON.parse(socket.sent[0]).audio_base_64,
      "base64",
    );
    expect(data.readInt16LE(0)).not.toBe(0);
  });

  it("retains unsent audio after a transient socket send failure", async () => {
    const { session, socket } = await startSession();
    socket.failuresRemaining = 1;
    session.writeAudioChunk(chunk());
    expect(socket.sent).toHaveLength(0);
    expect(retainedSamples()).toBe(320);
    session.writeAudioChunk(chunk());
    expect(retainedSamples()).toBe(0);
    expect(socket.sent).toHaveLength(1);
    const message = JSON.parse(socket.sent[0]);
    expect(Buffer.from(message.audio_base_64, "base64")).toHaveLength(1280);
  });

  it("retries a transient failure when sending the final audio chunk", async () => {
    const { session, socket } = await startSession();
    session.writeAudioChunk(new Float32Array(100).fill(0.5));
    socket.failuresRemaining = 1;
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
    const message = JSON.parse(socket.sent[0]);
    expect(message.commit).toBe(true);
    expect(Buffer.from(message.audio_base_64, "base64")).toHaveLength(640);
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "complete",
      }),
    });
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "complete",
      warnings: [],
    });
  });

  it("retries a failed terminal commit when there is no pending audio", async () => {
    const { session, socket } = await startSession();
    socket.failuresRemaining = 1;
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent).toEqual([
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: 16000,
      }),
    ]);
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "complete",
      }),
    });
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "complete",
      warnings: [],
    });
  });

  it("reports lost final audio if the socket closes while a send fails", async () => {
    const { session, socket } = await startSession();
    session.writeAudioChunk(new Float32Array(100).fill(0.5));
    socket.failuresRemaining = 1;
    socket.closeOnSendFailure = true;
    const result = await session.finalize({ samples: [], sampleRate: 16000 });
    expect(result.warnings).toEqual([
      "ElevenLabs finalization failed: ElevenLabs connection closed before finalization",
    ]);
    expect(result.rawTranscript).toBeNull();
  });

  it("reports a final send failure rather than silently dropping queued audio", async () => {
    const { session, socket } = await startSession();
    session.writeAudioChunk(new Float32Array(100).fill(0.5));
    socket.failuresRemaining = 2;
    const result = await session.finalize({ samples: [], sampleRate: 16000 });
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toEqual([
      "ElevenLabs finalization failed: Unable to send final audio or commit to ElevenLabs",
    ]);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("stops retaining audio once the socket has gone away", async () => {
    // Nothing in this session ever opens a second socket, so audio queued after
    // a close has no destination: `flushPendingSamples` returns immediately
    // because the socket is not OPEN, and `cleanup` already ran. Every chunk
    // pushed here used to stay in `pendingChunks` for the rest of the
    // recording -- hours of audio, never sent, held in the app's own heap.
    const { session, socket } = await startSession();
    session.writeAudioChunk(chunk());
    socket.close();
    expect(retainedSamples()).toBe(0);

    for (let i = 0; i < 200; i += 1) session.writeAudioChunk(chunk());

    expect(retainedSamples()).toBe(0);
    expect(socket.sent.length).toBe(1);
  });

  it("fails rather than returning a partial transcript after the socket closed", async () => {
    // Dropping the audio must not strand the finalize path: a recording that
    // lost its socket has to return whatever text arrived, not hang on a
    // timeout for a socket that is gone.
    const { session, socket } = await startSession();
    socket.onmessage?.({
      data: JSON.stringify({ message_type: "partial_transcript", text: "hi" }),
    });
    socket.close();
    session.writeAudioChunk(chunk());

    const result = await session.finalize({ samples: [], sampleRate: 16000 });
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toEqual([
      "ElevenLabs finalization failed: ElevenLabs connection closed before finalization",
    ]);
  });
  it("completes on a committed transcript and closes a synchronous socket once", async () => {
    const { session, socket } = await startSession();
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "committed_transcript",
        text: "complete",
      }),
    });
    await expect(pending).resolves.toMatchObject({
      rawTranscript: "complete",
      warnings: [],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("fails rather than returning a partial transcript after the finalization timeout", async () => {
    const { session, socket } = await startSession();
    socket.onmessage?.({
      data: JSON.stringify({
        message_type: "partial_transcript",
        text: "partial",
      }),
    });
    vi.useFakeTimers();
    const pending = session.finalize({ samples: [], sampleRate: 16000 });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [
        "ElevenLabs finalization failed: ElevenLabs finalization timed out",
      ],
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    vi.useRealTimers();
  });
});
