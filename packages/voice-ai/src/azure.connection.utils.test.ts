import { describe, expect, it, vi } from "vitest";
import type { IConnection } from "microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common/Exports.js";
import type {
  AuthInfo,
  IConnectionFactory,
  RecognizerConfig,
} from "microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/Exports.js";
import {
  createAbortableAzureConnectionFactory,
  createAzureConnectionScope,
  disposeAzureConnections,
} from "./azure.connection.utils";

const createConnection = () => {
  const open = vi.fn(() => new Promise<never>(() => undefined));
  const dispose = vi.fn(async () => undefined);
  const connection = {
    open,
    dispose,
    events: { attach: vi.fn() },
  } as unknown as IConnection;
  const factory = {
    create: vi.fn(async () => connection),
  } as unknown as IConnectionFactory;
  return { connection, factory, open, dispose };
};

const createConnectionFrom = (factory: IConnectionFactory) =>
  factory.create({} as RecognizerConfig, {} as AuthInfo);

describe("abortable Azure SDK connections", () => {
  it("closes the provider socket and rejects a stalled handshake on abort", async () => {
    const controller = new AbortController();
    const scope = createAzureConnectionScope(controller.signal);
    const { factory, open, dispose } = createConnection();
    const abortableFactory = createAbortableAzureConnectionFactory(
      factory,
      scope,
    );
    const capturedConnection = await createConnectionFrom(abortableFactory);
    const reason = new DOMException(
      "Provider startup timed out",
      "TimeoutError",
    );
    const opening = capturedConnection.open();
    const rejected = expect(opening).rejects.toBe(reason);

    controller.abort(reason);
    await rejected;
    await Promise.resolve();

    expect(open).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(scope.connections.size).toBe(0);
  });

  it("disposes an established SDK connection during session cleanup", async () => {
    const scope = createAzureConnectionScope();
    const { factory, open, dispose } = createConnection();
    open.mockImplementation(
      () => Promise.resolve({ statusCode: 200 }) as never,
    );
    const abortableFactory = createAbortableAzureConnectionFactory(
      factory,
      scope,
    );
    const capturedConnection = await createConnectionFrom(abortableFactory);
    await capturedConnection.open();

    disposeAzureConnections(scope);
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    expect(scope.connections.size).toBe(0);
  });

  it("preserves a caller's non-string abort reason during connection disposal", async () => {
    const controller = new AbortController();
    const reason = {
      toString: () => {
        throw new Error("abort reasons need not be strings");
      },
    };
    const scope = createAzureConnectionScope(controller.signal);
    const { factory, dispose } = createConnection();
    const abortableFactory = createAbortableAzureConnectionFactory(
      factory,
      scope,
    );
    const capturedConnection = await createConnectionFrom(abortableFactory);
    const opening = capturedConnection.open();
    const rejected = expect(opening).rejects.toBe(reason);

    controller.abort(reason);
    await rejected;
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    expect(scope.connections.size).toBe(0);
  });

  it("does not start the SDK handshake when the signal was already aborted", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Canceled", "AbortError");
    controller.abort(reason);
    const scope = createAzureConnectionScope(controller.signal);
    const { factory, open, dispose } = createConnection();
    const abortableFactory = createAbortableAzureConnectionFactory(
      factory,
      scope,
    );
    const capturedConnection = await createConnectionFrom(abortableFactory);

    await expect(capturedConnection.open()).rejects.toBe(reason);
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
