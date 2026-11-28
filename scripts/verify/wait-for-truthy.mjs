// The polling helper, in its own module so importing it costs nothing.
//
// It used to live in `cdp.mjs`, which launches nothing at import time but does
// check for a Chromium and extract one when absent. `scripts/ci/verify-wait-for-
// truthy.test.mjs` imports this helper to exercise it against a fake `evaluate`,
// so that check ran for a unit test: on a machine without a cached browser,
// `pnpm test:qa-docs` reached npm and downloaded one. A test for a pure function
// should not need the network.
//
// `evaluate` is injected rather than taking a `page`, so this is testable
// without a browser; `cdp.mjs` re-exports these for the scripts that also drive
// one.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `expression` evaluates to something truthy, or gives up.
 *
 * Returns `{ ok, waitedMs }` rather than throwing, because the callers differ in
 * what a timeout means: a screenshot script records it as a problem and carries
 * on to produce its report, while a strict check throws. Polling replaces a
 * fixed `sleep` that guessed how long the page needed; when the guess was short
 * the failure looked like a defect in the page.
 */
export async function waitForTruthy({
  evaluate,
  expression,
  timeoutMs = 30_000,
  intervalMs = 100,
  now = Date.now,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    // A page that is navigating can throw here, synchronously or as a rejected
    // promise; either way that is "not ready yet".
    let ready = false;
    try {
      ready = await evaluate(expression);
    } catch {
      ready = false;
    }
    if (ready) return { ok: true, waitedMs: now() - startedAt };
    if (now() >= deadline) return { ok: false, waitedMs: now() - startedAt };
    await sleep(intervalMs);
  }
}

export { sleep };
