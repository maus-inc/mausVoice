import { describe, expect, it } from "vitest";

import { SessionAbortScope } from "./session-abort-scope";

describe("SessionAbortScope", () => {
  it("hands out one signal that stays live until aborted", () => {
    const scope = new SessionAbortScope();
    expect(scope.isAborted).toBe(false);
    const signal = scope.signal;
    expect(signal.aborted).toBe(false);
    // Callers may hold the signal across the request; it must not be a
    // different signal each time.
    expect(scope.signal).toBe(signal);
  });

  it("aborts the signal, and stays aborted", () => {
    const scope = new SessionAbortScope();
    const signal = scope.signal;
    scope.abort();
    expect(signal.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isAborted).toBe(true);
  });

  it("tolerates cleanup running more than once", () => {
    const scope = new SessionAbortScope();
    scope.abort();
    expect(() => {
      scope.abort();
    }).not.toThrow();
    expect(scope.isAborted).toBe(true);
  });

  it("aborts with a reason a caller can read back", () => {
    const scope = new SessionAbortScope();
    const signal = scope.signal;
    scope.abort();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeDefined();
  });
});
