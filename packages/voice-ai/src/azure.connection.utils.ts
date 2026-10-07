import type { IConnection } from "microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common/Exports.js";
import type {
  AuthInfo,
  IConnectionFactory,
  RecognizerConfig,
} from "microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/Exports.js";

export type AzureConnectionScope = {
  signal?: AbortSignal;
  connections: Set<IConnection>;
};

export const createAzureConnectionScope = (
  signal?: AbortSignal,
): AzureConnectionScope => ({
  signal,
  connections: new Set(),
});

const getAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const createAbortableOpen = (
  connection: IConnection,
  signal: AbortSignal | undefined,
): IConnection["open"] => {
  const openConnection = connection.open.bind(connection);

  return () => {
    if (!signal) return openConnection();
    if (signal.aborted) {
      void connection
        .dispose("Azure connection aborted")
        .catch(() => undefined);
      return Promise.reject(getAbortReason(signal));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        return true;
      };
      const handleAbort = (): void => {
        if (!finish()) return;
        void connection
          .dispose("Azure connection aborted")
          .catch(() => undefined);
        reject(getAbortReason(signal));
      };

      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
        return;
      }

      // Promise construction turns a synchronous SDK throw into a rejection,
      // so the shared settlement path also removes the abort listener.
      const opening = new Promise<Awaited<ReturnType<IConnection["open"]>>>(
        (resolveOpen) => resolveOpen(openConnection()),
      );
      opening.then(
        (response) => {
          if (finish()) resolve(response);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  };
};

/**
 * The Speech SDK's recognizer disposal waits for its connection promise. If a
 * WebSocket handshake never settles, `recognizer.close()` therefore cannot
 * reach the socket it is meant to close. Keep the SDK connection objects as
 * they are created and make an in-progress `open()` abortable so cleanup can
 * close the underlying WebSocket directly instead of waiting for that promise.
 */
export const createAbortableAzureConnectionFactory = (
  factory: IConnectionFactory,
  scope: AzureConnectionScope,
): IConnectionFactory => ({
  create: async (
    config: RecognizerConfig,
    authInfo: AuthInfo,
    connectionId?: string,
  ) => {
    const connection = await factory.create(config, authInfo, connectionId);
    scope.connections.add(connection);

    connection.open = createAbortableOpen(connection, scope.signal);

    const disposeConnection = connection.dispose.bind(connection);
    let disposePromise: Promise<void> | null = null;
    connection.dispose = (reason?: string) => {
      scope.connections.delete(connection);
      if (disposePromise) return disposePromise;
      disposePromise = Promise.resolve().then(() => disposeConnection(reason));
      return disposePromise;
    };

    connection.events.attach((event) => {
      if (event.name === "ConnectionClosedEvent") {
        scope.connections.delete(connection);
      }
    });

    return connection;
  },
});

export const disposeAzureConnections = (
  scope: AzureConnectionScope,
  reason = "Azure speech session closed",
): void => {
  for (const connection of scope.connections) {
    try {
      void connection.dispose(reason).catch(() => undefined);
    } catch {
      // One failing connection must not prevent the rest from being closed.
    }
  }
  scope.connections.clear();
};
