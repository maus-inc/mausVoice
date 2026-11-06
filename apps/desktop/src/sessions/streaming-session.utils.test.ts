import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  verbose: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => loggerMocks,
}));

import type { AudioChunkBuffer } from "./transcription-stream.utils";
import {
  attachStreamingSocketHandlers,
  closeStreamingSocket,
  createBufferedChunkWriter,
  createFinalizeBookkeeper,
  createStartupSettler,
  type StartupSettler,
} from "./streaming-session.utils";

type FakeSocket = {
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  onerror: ((error: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
};

const fakeSocket = (readyState = 1): FakeSocket => ({
  readyState,
  close: vi.fn(),
  onerror: null,
  onclose: null,
});

const asWebSocket = (socket: FakeSocket) => socket as unknown as WebSocket;

beforeEach(() => {
  vi.stubGlobal("WebSocket", { OPEN: 1, CLOSING: 2, CLOSED: 3 });
  loggerMocks.error.mockClear();
  loggerMocks.verbose.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warning.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("closeStreamingSocket", () => {
  it("closes an open socket and resets the buffer", () => {
    const socket = fakeSocket();
    const reset = vi.fn();

    closeStreamingSocket(asWebSocket(socket), reset, "Test");

    expect(socket.close).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not re-close a closed socket but still resets", () => {
    const socket = fakeSocket(3);
    const reset = vi.fn();

    closeStreamingSocket(asWebSocket(socket), reset, "Test");

    expect(socket.close).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("tolerates a throwing close and still resets", () => {
    const socket = fakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error("close failed");
    });
    const reset = vi.fn();

    expect(() =>
      closeStreamingSocket(asWebSocket(socket), reset, "Test"),
    ).not.toThrow();
    expect(loggerMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to close the WebSocket"),
    );
    expect(reset).toHaveBeenCalledOnce();
  });
});

describe("createStartupSettler", () => {
  const makeSettler = (signal?: AbortSignal) => {
    const spies = {
      cleanup: vi.fn(),
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    const settler = createStartupSettler({
      signal,
      cleanup: spies.cleanup,
      resolve: spies.resolve,
      reject: spies.reject,
      session: { tag: "session" },
    });
    return { settler, ...spies };
  };

  it("resolves once with the session and ignores later callbacks", () => {
    const { settler, resolve, reject, cleanup } = makeSettler();

    settler.resolveStartup();
    settler.rejectStartup(new Error("too late"));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ tag: "session" });
    expect(reject).not.toHaveBeenCalled();
    expect(settler.settled).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("rejects with cleanup and ignores later callbacks", () => {
    const { settler, resolve, reject, cleanup } = makeSettler();

    settler.rejectStartup(new Error("boom"));
    settler.resolveStartup();

    expect(reject).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(settler.settled).toBe(true);
  });

  it("rejects synchronously for an already-aborted signal", () => {
    const controller = new AbortController();
    const reason = new Error("startup timed out");
    controller.abort(reason);
    const { settler, reject, cleanup } = makeSettler(controller.signal);

    expect(settler.settled).toBe(true);
    expect(reject).toHaveBeenCalledWith(reason);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects when the signal aborts before startup settles", () => {
    const controller = new AbortController();
    const { settler, reject, cleanup } = makeSettler(controller.signal);

    controller.abort(new Error("canceled"));

    expect(reject).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(settler.settled).toBe(true);
  });
});

describe("attachStreamingSocketHandlers", () => {
  const makeHandlers = (settler: StartupSettler) => {
    const socket = fakeSocket();
    const cleanup = vi.fn();
    const onSettledClose = vi.fn();
    attachStreamingSocketHandlers({
      socket: asWebSocket(socket),
      settler,
      cleanup,
      loggerPrefix: "Test",
      earlyCloseErrorMessage: "closed too early",
      onSettledClose,
    });
    return { socket, cleanup, onSettledClose };
  };

  const makeSettlerForHandlers = () => {
    const spies = { cleanup: vi.fn(), resolve: vi.fn(), reject: vi.fn() };
    const settler = createStartupSettler({
      signal: undefined,
      cleanup: spies.cleanup,
      resolve: spies.resolve,
      reject: spies.reject,
      session: { tag: "session" },
    });
    return { settler, ...spies };
  };

  it("rejects startup on a socket error before startup settles", () => {
    const parts = makeSettlerForHandlers();
    const { socket, cleanup } = makeHandlers(parts.settler);

    socket.onerror?.(new Error("network failure"));

    const reason = parts.reject.mock.calls.at(0)?.[0];
    expect(parts.reject).toHaveBeenCalledTimes(1);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("WebSocket connection failed");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("only cleans up on a socket error after startup settles", () => {
    const parts = makeSettlerForHandlers();
    parts.settler.resolveStartup();
    const { socket, cleanup } = makeHandlers(parts.settler);

    socket.onerror?.(new Error("network failure"));

    expect(parts.reject).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects startup with the provider's early-close message before settlement", () => {
    const parts = makeSettlerForHandlers();
    const { socket, onSettledClose, cleanup } = makeHandlers(parts.settler);

    socket.onclose?.({ code: 1006, reason: "dropped" });

    const reason = parts.reject.mock.calls.at(0)?.[0];
    expect(parts.reject).toHaveBeenCalledTimes(1);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("closed too early");
    expect(onSettledClose).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs the settled-close hook before cleanup after settlement", () => {
    const parts = makeSettlerForHandlers();
    parts.settler.resolveStartup();
    const { socket, onSettledClose, cleanup } = makeHandlers(parts.settler);

    socket.onclose?.({ code: 1000, reason: "done" });

    expect(parts.reject).not.toHaveBeenCalled();
    expect(onSettledClose).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("logs closes at verbose level by default and info when asked", () => {
    const verboseParts = makeSettlerForHandlers();
    verboseParts.settler.resolveStartup();
    const verbose = makeHandlers(verboseParts.settler);
    verbose.socket.onclose?.({ code: 1000, reason: "done" });
    expect(loggerMocks.verbose).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket closed:"),
      { code: 1000, reason: "done" },
    );

    const infoParts = makeSettlerForHandlers();
    infoParts.settler.resolveStartup();
    const socket = fakeSocket();
    attachStreamingSocketHandlers({
      socket: asWebSocket(socket),
      settler: infoParts.settler,
      cleanup: vi.fn(),
      loggerPrefix: "Test",
      earlyCloseErrorMessage: "closed too early",
      closeLogLevel: "info",
    });
    socket.onclose?.({ code: 1000, reason: "done" });
    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket closed:"),
      { code: 1000, reason: "done" },
    );
  });
});

describe("createFinalizeBookkeeper", () => {
  it("resolves the pending finalize with the current text", () => {
    const cleanup = vi.fn();
    const bookkeeper = createFinalizeBookkeeper({
      cleanup,
      getText: () => "final text",
      loggerPrefix: "Test",
    });
    const resolve = vi.fn();

    expect(bookkeeper.pending).toBe(false);
    bookkeeper.begin(resolve);
    expect(bookkeeper.pending).toBe(true);
    bookkeeper.complete();

    expect(resolve).toHaveBeenCalledWith("final text");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bookkeeper.pending).toBe(false);
  });

  it("is a no-op when nothing is pending", () => {
    const cleanup = vi.fn();
    const bookkeeper = createFinalizeBookkeeper({
      cleanup,
      getText: () => "text",
      loggerPrefix: "Test",
    });

    expect(() => bookkeeper.complete()).not.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("resolves when the armed timeout fires and ignores a later complete", () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const bookkeeper = createFinalizeBookkeeper({
      cleanup,
      getText: () => "timed out text",
      loggerPrefix: "Test",
    });
    const resolve = vi.fn();

    bookkeeper.begin(resolve);
    bookkeeper.armTimeout(3000, "Timeout reached, length:");
    vi.advanceTimersByTime(3000);

    expect(resolve).toHaveBeenCalledWith("timed out text");
    expect(bookkeeper.pending).toBe(false);

    bookkeeper.complete();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("completes before the timeout without double-settling", () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const bookkeeper = createFinalizeBookkeeper({
      cleanup,
      getText: () => "early text",
      loggerPrefix: "Test",
    });
    const resolve = vi.fn();

    bookkeeper.begin(resolve);
    bookkeeper.armTimeout(3000, "Timeout reached, length:");
    bookkeeper.complete();
    vi.advanceTimersByTime(5000);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("early text");
  });
});

describe("createBufferedChunkWriter", () => {
  const makeBuffer = () =>
    ({
      push: vi.fn(),
      flush: vi.fn(),
      reset: vi.fn(),
      pendingSampleCount: vi.fn(() => 0),
    }) as unknown as AudioChunkBuffer;

  it("queues and flushes every chunk while not finalized", () => {
    const buffer = makeBuffer();
    const writer = createBufferedChunkWriter({
      buffer,
      isFinalized: () => false,
      loggerPrefix: "Test",
    });

    const chunk = new Float32Array([0.5]);
    writer(chunk);

    expect(buffer.push).toHaveBeenCalledWith(chunk);
    expect(buffer.flush).toHaveBeenCalledWith(false);
  });

  it("drops chunks after finalization", () => {
    const buffer = makeBuffer();
    const writer = createBufferedChunkWriter({
      buffer,
      isFinalized: () => true,
      loggerPrefix: "Test",
    });

    writer(new Float32Array([0.5]));

    expect(buffer.push).not.toHaveBeenCalled();
    expect(buffer.flush).not.toHaveBeenCalled();
  });

  it("logs instead of throwing when buffering fails", () => {
    const buffer = makeBuffer();
    vi.mocked(buffer.push).mockImplementation(() => {
      throw new Error("buffer full");
    });
    const writer = createBufferedChunkWriter({
      buffer,
      isFinalized: () => false,
      loggerPrefix: "Test",
    });

    expect(() => writer(new Float32Array([0.5]))).not.toThrow();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Error sending audio chunk:"),
      expect.any(Error),
    );
  });
});
