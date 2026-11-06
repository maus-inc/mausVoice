import http from "node:http";

/** Wait for a local driver without leaving retries alive after it settles. */
export function waitForHttpServer({
  port,
  requestPath = "/status",
  timeoutMs = 30_000,
  intervalMs = 500,
  request = http.request,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer;
    let active;
    let reason = `Server on port ${port} did not respond with success before timeout.`;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) {
        active?.destroy();
        reject(error);
      } else {
        resolve();
      }
    };

    const abort = () =>
      finish(signal?.reason ?? new Error("Webdriver readiness cancelled"));
    const deadline = setTimeout(() => finish(new Error(reason)), timeoutMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const attempt = () => {
      if (settled) return;
      let ended = false;
      const retry = (message) => {
        if (settled || ended) return;
        ended = true;
        active = undefined;
        reason = message;
        retryTimer = setTimeout(attempt, intervalMs);
      };
      let req;
      try {
        req = request(
          {
            host: "127.0.0.1",
            port,
            path: requestPath,
            method: "GET",
            timeout: 2_000,
          },
          (response) => {
            response.resume();
            if (settled || ended) return;
            if (
              response.statusCode &&
              response.statusCode >= 200 &&
              response.statusCode < 500
            ) {
              ended = true;
              active = undefined;
              finish();
            } else {
              retry(
                `Server on port ${port} did not respond with success before timeout.`,
              );
            }
          },
        );
        active = req;
        req.on("error", (error) =>
          retry(`Could not reach server on port ${port}: ${error.message}`),
        );
        req.on("timeout", () => {
          if (settled || ended) return;
          req.destroy();
          retry(`Timed out waiting for server on port ${port} to respond.`);
        });
        req.end();
      } catch (error) {
        finish(
          error ?? new Error("Could not start Webdriver readiness request"),
        );
      }
    };
    attempt();
  });
}
