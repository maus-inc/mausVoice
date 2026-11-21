// Unit tests for the readiness poll the verify scripts use in place of a fixed
// sleep. The point of the change was that a fixed delay could not tell "not
// ready yet" from "broken", so the timeout arm is tested as carefully as the
// success arm.
import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForTruthy } from "../verify/wait-for-truthy.mjs";

// A clock the test moves by hand, so these run instantly and without sleeping.
const manualClock = (start = 0) => {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
};

test("returns ok as soon as the expression is truthy", async () => {
  const clock = manualClock();
  let reads = 0;
  const result = await waitForTruthy({
    evaluate: () => {
      reads += 1;
      return reads >= 3; // ready on the third read
    },
    expression: "ignored",
    timeoutMs: 10_000,
    intervalMs: 100,
    now: clock.now,
  });

  assert.equal(result.ok, true);
  // Three reads, not more: it stops at the first truthy answer rather than
  // polling for the rest of the window.
  assert.equal(reads, 3);
  assert.ok(result.waitedMs >= 0);
});

test("gives up at the deadline and reports not ok instead of throwing", async () => {
  // The failure has to be a value, because the screenshot script records it in
  // its problem list rather than dying before it writes a report.
  const clock = manualClock();
  const advanceOnSleep = { current: clock };
  let reads = 0;
  const result = await Promise.race([
    waitForTruthy({
      evaluate: () => {
        reads += 1;
        advanceOnSleep.current.advance(100);
        return false;
      },
      expression: "ignored",
      timeoutMs: 100,
      intervalMs: 100,
      now: clock.now,
    }),
    // A helper that never gives up would hang the suite; this turns that into a
    // failure with a useful message instead.
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: "never returned" }), 5_000).unref(),
    ),
  ]);

  assert.equal(result.ok, false);
  // Bounded: it did not spin forever. Asserting the count is what makes this
  // fail fast when the deadline check is removed -- the suite reports a wrong
  // number of reads instead of hanging until the runner's own timeout.
  assert.ok(reads <= 3, `expected a bounded number of reads, saw ${reads}`);
});

test("treats a throwing evaluate as not ready yet", async () => {
  // A page mid-navigation throws from `Runtime.evaluate`. That is a reason to
  // look again, not a reason to fail the run on the first attempt.
  const clock = manualClock();
  let attempts = 0;
  const result = await waitForTruthy({
    evaluate: () => {
      attempts += 1;
      clock.advance(100);
      if (attempts < 3) throw new Error("Execution context was destroyed");
      return true;
    },
    expression: "ignored",
    timeoutMs: 10_000,
    intervalMs: 100,
    now: clock.now,
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});
