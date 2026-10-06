import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    stopwatch: vi.fn(),
  }),
  redactQueryParamValues: (url: string) => url,
}));

const secureFetchMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ token: "single-use-token" }),
    text: async () => "",
  })),
);

vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: secureFetchMock,
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
  url: string;
  sent: string[] = [];
  throwOnClose = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string | ArrayBufferView | Blob) {
    if (typeof data === "string") this.sent.push(data);
  }

  close() {
    if (this.throwOnClose) throw new Error("socket close failed");
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

const startSession = async () => {
  const session = new ElevenLabsTranscriptionSession("test-key");
  const started = session.onRecordingStart(16000);
  await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
  const socket = latestSocket();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ message_type: "session_started" }),
  });
  await started;
  return { session, socket };
};

/** Samples currently held in the pending queue. */
const retainedSamples = () => latestQueueValue();

describe("ElevenLabs audio retention across a socket close", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    queueCounters.length = 0;
    secureFetchMock.mockClear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("waits for session_started after the WebSocket opens", async () => {
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    const socket = latestSocket();
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    session.writeAudioChunk(chunk());
    socket.open();

    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.onmessage?.({
      data: JSON.stringify({ message_type: "session_started" }),
    });
    await started;

    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(socket.sent).toEqual([]);
    session.writeAudioChunk(chunk());
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  it("aborts pending provider startup and closes the WebSocket", async () => {
    const controller = new AbortController();
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000, controller.signal);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    const socket = latestSocket();

    expect(secureFetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      expect.objectContaining({ signal: controller.signal }),
    );

    controller.abort(new Error("startup timed out"));

    await expect(started).rejects.toThrow("startup timed out");
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("clears retained audio even when WebSocket close throws", async () => {
    const { session, socket } = await startSession();
    socket.readyState = FakeWebSocket.CONNECTING;
    session.writeAudioChunk(chunk());
    expect(retainedSamples()).toBe(320);
    socket.throwOnClose = true;

    expect(() => session.cleanup()).not.toThrow();

    expect(retainedSamples()).toBe(0);
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

  it("still finalizes with a transcript after the socket closed", async () => {
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
    expect(result.rawTranscript).toContain("hi");
    expect(result.warnings).toEqual([]);
  });
});
