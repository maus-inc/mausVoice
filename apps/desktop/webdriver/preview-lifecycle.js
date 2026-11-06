/** Close a preview without allowing cleanup failures to become unhandled. */
export function closePreview(server) {
  try {
    Promise.resolve(server.close()).catch((error) => {
      console.error("Failed to close preview server:", error);
    });
  } catch (error) {
    console.error("Failed to close preview server:", error);
  }
}

/** Creation cannot be cancelled by Vite; dispose a server that arrives late. */
export function waitForPreviewCreation(creation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(creation).then(
      (server) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) closePreview(server);
        else resolve(server);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Wait for Vite's HTTP listener and detach listeners on every terminal path. */
export function waitForPreviewListening(server, signal) {
  signal.throwIfAborted();
  const httpServer = server.httpServer;
  if (!httpServer || httpServer.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      httpServer.off("error", fail);
      httpServer.off("listening", ready);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const abort = () => fail(signal.reason);
    httpServer.once("error", fail);
    httpServer.once("listening", ready);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
