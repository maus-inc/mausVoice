import { GladiaClient } from "@gladiaio/sdk";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createGladiaLiveClient,
  createGladiaStreamingSession,
  GLADIA_LIVE_RETRY_CLOSE_CODES,
  readGladiaLiveWsRetryConfig,
} from "./gladia.utils";

/**
 * The minimum surface `WebSocketSession` uses from a socket. The SDK builds
 * its socket through `newWebSocket`, which prefers a global `WebSocket`, so
 * installing this class exercises the real client, the real retry accounting,
 * and the real close-code gate.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  /** True once a server accepted the upgrade, so teardown can require a close. */
  wasOpen = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(): void {}

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Complete the handshake the way a live server accepts the upgrade. */
  open(): void {
    this.readyState = 1;
    this.wasOpen = true;
    this.onopen?.();
  }

  /** An abnormal closure, which is what a dropped network connection sends. */
  dropFromNetwork(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

/**
 * Stands in for the real socket outside a test body, so a session that outlives
 * its test and rebuilds once the fake is gone is caught here instead of
 * opening a connection to Gladia. Every test asserts this list is empty.
 */
class NetworkGuardWebSocket {
  static attempts: string[] = [];

  readyState = 0;

  constructor(readonly url: string) {
    NetworkGuardWebSocket.attempts.push(url);
  }

  send(): void {}
  close(): void {}
}

type FakeWebSocketSession = {
  onopen: ((event: { connection: number; attempt: number }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  close: (code?: number, reason?: string) => void;
};

type LiveClientWithSocketClient = {
  webSocketClient: { createSession: (url: string) => FakeWebSocketSession };
};

const nativeWebSocket = globalThis.WebSocket;
const installWebSocket = (implementation: unknown): void => {
  globalThis.WebSocket = implementation as typeof WebSocket;
};
/** Sessions to close at teardown, so no test leaves a live rebuild pending. */
const openSessions: FakeWebSocketSession[] = [];

/** A socket session on the real client, tracked for teardown. */
const createTrackedSession = (client: GladiaClient): FakeWebSocketSession => {
  const socketClient = (
    client.liveV2() as unknown as LiveClientWithSocketClient
  ).webSocketClient;
  const session = socketClient.createSession(
    "wss://api.gladia.io/v2/live/socket-1",
  );
  openSessions.push(session);
  return session;
};

const createRealSession = (apiKey = "test-key") =>
  createTrackedSession(createGladiaLiveClient({ apiKey }));

/**
 * Lets the SDK finish `connect()`. The session awaits the socket, so it only
 * attaches its `onopen`/`onclose` handlers on a later turn. Virtual time makes
 * that turn deterministic and keeps the SDK's connection-timeout timer, which
 * the session clears on open, inside the fake clock.
 */
const nextTurn = () => vi.advanceTimersByTimeAsync(0);

/** Opens every socket the session creates, counting the reconnects. */
const dropRepeatedly = async (
  session: FakeWebSocketSession,
  drops: number,
): Promise<number[]> => {
  const closed: number[] = [];
  session.onclose = (event) => {
    closed.push(event.code);
  };
  for (let index = 0; index < drops; index++) {
    const current = FakeSocket.instances[FakeSocket.instances.length - 1];
    await nextTurn();
    current?.open();
    current?.dropFromNetwork();
  }
  await nextTurn();
  return closed;
};

beforeAll(() => {
  // Virtual time for the whole file: no real timer survives a test, so a
  // pending SDK retry cannot fire after the teardown assertions have run.
  vi.useFakeTimers();
  // The guard goes in first so nothing can reach the real socket at any point.
  installWebSocket(NetworkGuardWebSocket);
});

afterAll(() => {
  vi.useRealTimers();
  installWebSocket(nativeWebSocket);
});

beforeEach(() => {
  FakeSocket.instances = [];
  NetworkGuardWebSocket.attempts = [];
  openSessions.length = 0;
  installWebSocket(FakeSocket);
});

afterEach(() => {
  // The guard replaces the fake before the teardown, so a rebuild triggered by
  // a close is recorded rather than opened.
  installWebSocket(NetworkGuardWebSocket);
  for (const session of openSessions.splice(0)) {
    session.close(1000, "test teardown");
  }
  // No live connection was attempted, from inside a test or from a rebuild a
  // teardown close kicked off.
  expect(NetworkGuardWebSocket.attempts).toEqual([]);
  // Every socket the service had accepted is closed again. A socket that never
  // completed its handshake holds no handle: the SDK drops its reference when
  // the session closes.
  expect(
    FakeSocket.instances.filter(
      (socket) => socket.wasOpen && socket.readyState !== 3,
    ),
  ).toEqual([]);
  // Every SDK timer, including the connection timeout of the last socket, is
  // cleared by the close above.
  expect(vi.getTimerCount()).toBe(0);
});

describe("Gladia live retry configuration", () => {
  it("pins an unbounded connection budget and an iterable close-code list", () => {
    const config = readGladiaLiveWsRetryConfig(
      createGladiaLiveClient({ apiKey: "test-key" }),
    );

    // The budget is charged for the whole session, not per outage, so it must
    // be unbounded. Establishment is still bounded by
    // maxAttemptsPerConnection, so this is not an infinite loop.
    expect(config.maxConnections).toBe(0);
    expect(config.maxAttemptsPerConnection).toBe(3);
    expect(Array.isArray(config.closeCodes)).toBe(true);
    expect(config.closeCodes).toEqual([
      [1002, 4399],
      [4500, 9999],
    ]);
    // 1006 is an abnormal closure, the code a network drop produces, and it
    // is already inside the first range.
    expect(
      config.closeCodes.some(
        (code) =>
          code === 1006 ||
          (Array.isArray(code) && code[0] <= 1006 && 1006 <= code[1]),
      ),
    ).toBe(true);
  });

  it("cannot take the close-code list through the constructor options", () => {
    // Documented vendor trap. `deepMergeObjects` recurses into any option
    // where both sides are objects, so an array comes back as `{0: …, 1: …}`
    // and the SDK's own `for (const item of list)` throws. If a future SDK
    // release merges arrays correctly, this test fails and the list can move
    // back into the constructor.
    const client = new GladiaClient({
      apiKey: "test-key",
      wsRetry: {
        closeCodes: [
          [1002, 4399],
          [4500, 9999],
        ],
      },
    });
    const closeCodes = (
      client as unknown as {
        options: { wsRetry: { closeCodes: unknown } };
      }
    ).options.wsRetry.closeCodes;

    expect(Array.isArray(closeCodes)).toBe(false);
    expect(() => [...(closeCodes as Iterable<never>)]).toThrow(TypeError);
  });
});

describe("Gladia live reconnect through the real SDK client", () => {
  it("keeps reconnecting across ten network drops instead of stopping at four", async () => {
    const drops = 10;
    const session = createRealSession();
    const closed = await dropRepeatedly(session, drops);

    // One socket to open, then one rebuild per drop.
    expect(FakeSocket.instances).toHaveLength(drops + 1);
    // The session is still alive, so the SDK never surfaced a terminal close.
    expect(closed).toEqual([]);
    expect(session.onclose).not.toBeNull();
  });

  it("stops at the fourth drop when the connection budget is finite", async () => {
    // The regression this fix exists for. The SDK charges every reconnect
    // against maxConnections for the whole session
    // (`connectionCount` only resets inside `connect(isRetry = false)`), so a
    // budget of 4 ends the live session on the fourth drop.
    const session = createTrackedSession(
      new GladiaClient({
        apiKey: "test-key",
        wsRetry: { maxAttemptsPerConnection: 3, maxConnections: 4 },
      }),
    );
    const closed = await dropRepeatedly(session, 10);

    expect(FakeSocket.instances).toHaveLength(4);
    expect(closed).toEqual([1006]);
  });

  it("exposes the pinned close codes to the WebSocket client", async () => {
    const session = createRealSession();
    await nextTurn();
    FakeSocket.instances[0]?.open();

    // A code outside the policy still ends the session, which proves the
    // pinned list is the one being consulted.
    FakeSocket.instances[0]?.close(1000, "normal");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(session.onclose).toBeNull();
  });

  it("warns on a real reconnect and stays quiet on the first connect", async () => {
    // End to end through the SDK's own live session, so the counter the
    // warning is gated on is the one the SDK really sends. The WebSocket client
    // emits `{ connection, attempt }` and the live session forwards it as
    // `{ attempt: connection }`, so the value that identifies a reconnect is
    // the connection count, and the per-connection attempt never arrives.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "live-1",
            created_at: "2026-01-01T00:00:00.000Z",
            url: "wss://api.gladia.io/v2/live/socket-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      const onConnectionInterrupted = vi.fn();
      const session = createGladiaStreamingSession({
        apiKey: "test-key",
        sampleRate: 16000,
        language: "auto",
        onConnectionInterrupted,
      });
      const reconnectWarning = "Gladia live connection dropped; reconnecting.";

      // The initial connect never reaches the live session: the SDK emits it
      // from inside `createSession`, before it attaches its own handler, so
      // there is no interruption and no warning to report for a healthy start.
      await nextTurn();
      expect(FakeSocket.instances).toHaveLength(1);
      expect(session.getWarnings()).not.toContain(reconnectWarning);
      expect(onConnectionInterrupted).not.toHaveBeenCalled();
      FakeSocket.instances[0]?.open();

      // A rebuild after a drop is a reconnect, and it is the first event the
      // live session does see.
      FakeSocket.instances[0]?.dropFromNetwork();
      await nextTurn();
      expect(FakeSocket.instances).toHaveLength(2);
      expect(session.getWarnings()).toContain(reconnectWarning);
      expect(onConnectionInterrupted).toHaveBeenCalledOnce();

      session.cleanup();
      await nextTurn();
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});

describe("GLADIA_LIVE_RETRY_CLOSE_CODES", () => {
  it("matches the ranges the SDK documents as its default", () => {
    expect(GLADIA_LIVE_RETRY_CLOSE_CODES).toEqual([
      [1002, 4399],
      [4500, 9999],
    ]);
  });
});
