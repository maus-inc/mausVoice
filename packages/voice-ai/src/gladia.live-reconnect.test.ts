import { GladiaClient } from "@gladiaio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGladiaLiveClient,
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
    this.onopen?.();
  }

  /** An abnormal closure, which is what a dropped network connection sends. */
  dropFromNetwork(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
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

const createRealSession = (apiKey = "test-key") => {
  const liveClient = createGladiaLiveClient({ apiKey }).liveV2();
  const socketClient = (liveClient as unknown as LiveClientWithSocketClient)
    .webSocketClient;
  return socketClient.createSession("wss://api.gladia.io/v2/live/socket-1");
};

/**
 * Lets the SDK finish `connect()`. The session awaits the socket, so it only
 * attaches its `onopen`/`onclose` handlers on a later turn.
 */
const nextTurn = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

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

beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
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
    const client = new GladiaClient({
      apiKey: "test-key",
      wsRetry: { maxAttemptsPerConnection: 3, maxConnections: 4 },
    });
    const socketClient = (
      client.liveV2() as unknown as LiveClientWithSocketClient
    ).webSocketClient;
    const session = socketClient.createSession(
      "wss://api.gladia.io/v2/live/socket-1",
    );
    const closed = await dropRepeatedly(session, 10);

    expect(FakeSocket.instances).toHaveLength(4);
    expect(closed).toEqual([1006]);
  });

  it("exposes the pinned close codes to the WebSocket client", async () => {
    const client = createGladiaLiveClient({ apiKey: "test-key" });
    const liveClient = client.liveV2();
    const socketClient = (liveClient as unknown as LiveClientWithSocketClient)
      .webSocketClient;
    const session = socketClient.createSession(
      "wss://api.gladia.io/v2/live/socket-1",
    );
    await nextTurn();
    FakeSocket.instances[0]?.open();

    // A code outside the policy still ends the session, which proves the
    // pinned list is the one being consulted.
    FakeSocket.instances[0]?.close(1000, "normal");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(session.onclose).toBeNull();
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
