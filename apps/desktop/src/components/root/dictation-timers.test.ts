import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOwnedTimer,
  hasOwnedTimer,
  scheduleOwnedTimer,
} from "./dictation-timers";

type Timer = ReturnType<typeof setTimeout>;

describe("dictation timer ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recognizes and clears timer handle zero", () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {});
    const ref = { current: 0 as unknown as Timer | null };
    expect(hasOwnedTimer(ref)).toBe(true);
    clearOwnedTimer(ref);
    expect(clear).toHaveBeenCalledWith(0);
    expect(ref.current).toBeNull();
    clearOwnedTimer(ref);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("releases the timer handle before running its callback", () => {
    let fire = () => {};
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      fire = callback as () => void;
      return 0 as unknown as Timer;
    });
    const ref: { current: Timer | null } = { current: null };
    const callback = vi.fn(() => expect(ref.current).toBeNull());
    scheduleOwnedTimer(ref, callback, 100);
    expect(hasOwnedTimer(ref)).toBe(true);
    fire();
    expect(callback).toHaveBeenCalledOnce();
    expect(hasOwnedTimer(ref)).toBe(false);
  });

  it("distinguishes a retired callback even if the platform reuses its handle", () => {
    const callbacks: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      callbacks.push(callback as () => void);
      return 0 as unknown as Timer;
    });
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const ref: { current: Timer | null } = { current: null };
    const first = vi.fn();
    const second = vi.fn();
    scheduleOwnedTimer(ref, first, 100);
    scheduleOwnedTimer(ref, second, 100);
    callbacks[0]();
    expect(first).not.toHaveBeenCalled();
    expect(hasOwnedTimer(ref)).toBe(true);
    callbacks[1]();
    expect(second).toHaveBeenCalledOnce();
  });

  it("does not let a cancelled callback fire after replacement", () => {
    const callbacks: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      callbacks.push(callback as () => void);
      return callbacks.length as unknown as Timer;
    });
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const ref: { current: Timer | null } = { current: null };
    const first = vi.fn();
    const second = vi.fn();
    scheduleOwnedTimer(ref, first, 100);
    scheduleOwnedTimer(ref, second, 100);
    callbacks[0]();
    expect(first).not.toHaveBeenCalled();
    callbacks[1]();
    expect(second).toHaveBeenCalledOnce();
    expect(ref.current).toBeNull();
  });
});
