import { describe, expect, it } from "vitest";
import {
  getPostProcessEditRetranscribeDelayMs,
  nextPostProcessEditFailureCount,
  POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER,
  POST_PROCESS_EDIT_RETRANSCRIBE_BASE_DELAY_MS,
  POST_PROCESS_EDIT_RETRANSCRIBE_MAX_DELAY_MS,
  shouldAutomaticallyRetranscribePostProcessEditFailure,
} from "./post-process-retry.utils";

describe("post-process edit retry policy", () => {
  it("increments a missing or invalid persisted count from zero", () => {
    expect(nextPostProcessEditFailureCount(undefined)).toBe(1);
    expect(nextPostProcessEditFailureCount(null)).toBe(1);
    expect(nextPostProcessEditFailureCount(Number.NaN)).toBe(1);
    expect(nextPostProcessEditFailureCount(-4)).toBe(1);
  });

  it("triggers after the failure count exceeds the two-failure threshold", () => {
    expect(
      shouldAutomaticallyRetranscribePostProcessEditFailure(
        POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER,
      ),
    ).toBe(false);
    expect(shouldAutomaticallyRetranscribePostProcessEditFailure(3)).toBe(true);
    // A marker-write failure must not make a later failure in the same chain
    // ineligible for recovery. The durable marker and in-flight set still bound
    // the actual automatic pass to one run.
    expect(shouldAutomaticallyRetranscribePostProcessEditFailure(4)).toBe(true);
    expect(shouldAutomaticallyRetranscribePostProcessEditFailure(null)).toBe(
      false,
    );
  });

  it("keeps jitter within the bounded exponential delay", () => {
    expect(getPostProcessEditRetranscribeDelayMs(3, 0)).toBe(0);
    expect(getPostProcessEditRetranscribeDelayMs(3, 1)).toBe(
      POST_PROCESS_EDIT_RETRANSCRIBE_BASE_DELAY_MS,
    );
    expect(getPostProcessEditRetranscribeDelayMs(99, 1)).toBe(
      POST_PROCESS_EDIT_RETRANSCRIBE_MAX_DELAY_MS,
    );
    expect(getPostProcessEditRetranscribeDelayMs(3, Number.NaN)).toBe(0);
  });
});
