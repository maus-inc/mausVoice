import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => [] as MockSocket[]);

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  throwOnClose = false;
  readonly close = vi.fn(() => {
    if (this.throwOnClose) throw new Error("socket close failed");
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = protocols;
    sockets.push(this);
  }
}

type MockSocket = InstanceType<typeof MockWebSocket>;

vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/deepgram.utils", () => ({
  buildDeepgramWebSocketUrl: () => "wss://deepgram.example.test",
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
  }),
  redactQueryParamValues: (value: string) => value,
}));
vi.mock("../utils/prompt.utils", () => ({
  buildProviderVocabulary: () => ({ terms: [], warning: null }),
  collectDictionaryEntries: () => [],
  DEEPGRAM_KEYTERM_BUDGET: 100,
}));
vi.mock("../utils/user.utils", () => ({
  loadMyEffectiveDictationLanguage: vi.fn().mockResolvedValue("en-US"),
}));

import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";

const waitForSocket = async (): Promise<MockSocket> => {
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  if (!socket) throw new Error("Expected Deepgram to create a WebSocket");
  return socket;
};

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Deepgram provider startup cancellation", () => {
  it("closes a pending WebSocket and rejects startup with the abort reason", async () => {
    const session = new DeepgramTranscriptionSession("api-key");
    const controller = new AbortController();
    const reason = new DOMException(
      "Provider startup timed out",
      "TimeoutError",
    );
    const startup = session.onRecordingStart(16_000, controller.signal);
    const socket = await waitForSocket();

    controller.abort(reason);

    await expect(startup).rejects.toBe(reason);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("settles aborted startup when WebSocket close throws", async () => {
    const session = new DeepgramTranscriptionSession("api-key");
    const controller = new AbortController();
    const reason = new Error("startup canceled");
    const startup = session.onRecordingStart(16_000, controller.signal);
    const socket = await waitForSocket();
    socket.throwOnClose = true;

    controller.abort(reason);

    await expect(startup).rejects.toBe(reason);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(() => session.cleanup()).not.toThrow();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("rejects a socket that closes before the provider session is ready", async () => {
    const session = new DeepgramTranscriptionSession("api-key");
    const startup = session.onRecordingStart(16_000);
    const socket = await waitForSocket();

    socket.readyState = MockWebSocket.CLOSED;
    socket.onclose?.({ code: 1006, reason: "connection lost" } as CloseEvent);

    await expect(startup).rejects.toThrow(
      "WebSocket closed before the connection opened",
    );
    await expect(
      session.finalize({ samples: new Float32Array(), sampleRate: 16_000 }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [
        expect.stringContaining("streaming session was not established"),
      ],
    });
  });

  it("closes an established provider socket when the session is cleaned up", async () => {
    const session = new DeepgramTranscriptionSession("api-key");
    const startup = session.onRecordingStart(16_000);
    const socket = await waitForSocket();

    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.({} as Event);
    await expect(startup).resolves.toBeUndefined();

    session.cleanup();

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });
});
