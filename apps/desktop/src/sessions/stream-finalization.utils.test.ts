import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeStreamFinalization,
  type StreamFinalizationState,
} from "./stream-finalization.utils";

const log = vi.hoisted(() => vi.fn());
vi.mock("../utils/log.utils", () => ({ getLogger: () => ({ verbose: log }) }));
afterEach(() => {
  vi.restoreAllMocks();
  log.mockClear();
});

describe("completeStreamFinalization", () => {
  it("cancels even a zero-valued timer and resolves once through reentrant cleanup", () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    const resolve = vi.fn();
    const state: StreamFinalizationState = {
      resolver: resolve,
      timeout: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    let text = "before";
    const getText = () => text;
    const cleanup = vi.fn(() => {
      text = "after";
      completeStreamFinalization(state, cleanup, getText, "provider");
    });
    completeStreamFinalization(state, cleanup, getText, "provider");
    expect(clear).toHaveBeenCalledWith(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledExactlyOnceWith("after");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[provider] Completing finalize with transcript length:",
      6,
    );
    expect(state).toEqual({ resolver: null, timeout: null });
  });

  it("clears a pending timer without closing when there is no resolver", () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    const state: StreamFinalizationState = {
      resolver: null,
      timeout: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    const cleanup = vi.fn();
    completeStreamFinalization(state, cleanup, () => "", "provider");
    expect(clear).toHaveBeenCalledWith(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(state.timeout).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
