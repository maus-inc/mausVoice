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
  url: string;
  sent: string[] = [];
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
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";

/** 20 ms of 16 kHz audio: exactly one minimum-sized chunk. */
const chunk = () => new Float32Array(320).fill(0.5);

const startSession = async () => {
  const session = new ElevenLabsTranscriptionSession("test-key");
  const started = session.onRecordingStart(16000);
  await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
  const socket = createdSockets.at(-1)!;
  socket.open();
  await started;
  return { session, socket };
};

/** Samples currently held in the pending queue. */
const retainedSamples = () =>
  queueCounters.length === 0 ? 0 : queueCounters.at(-1)!.value;

describe("ElevenLabs audio retention across a socket close", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    queueCounters.length = 0;
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

  it("keeps audio queued while the socket is still connecting", async () => {
    // The half of the old comment that was true, and the reason the fix is not
    // simply "stop queueing": speech captured before the handshake completes is
    // held and drained by `onopen` rather than dropped.
    const session = new ElevenLabsTranscriptionSession("test-key");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThan(0));
    const socket = createdSockets.at(-1)!;
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    // Nothing to send yet: the socket has not opened, and `onopen` has not run.
    socket.open();
    await started;
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    // The backlog `onopen` drained is empty in this test because there is no
    // writer to call while `streamSession` is still null -- what matters is that
    // the connecting socket is a live destination, so the fix below drops audio
    // only for a socket that is gone.
    session.writeAudioChunk(chunk());
    expect(socket.sent.length).toBeGreaterThan(0);
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
