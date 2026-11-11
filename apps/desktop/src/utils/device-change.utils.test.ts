import { describe, expect, it, vi } from "vitest";
import { subscribeDeviceChange } from "./device-change.utils";

describe("subscribeDeviceChange", () => {
  it("adds and removes the devicechange listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const onChange = vi.fn();

    const unsubscribe = subscribeDeviceChange(
      { addEventListener, removeEventListener },
      onChange,
    );

    expect(addEventListener).toHaveBeenCalledWith("devicechange", onChange);
    unsubscribe?.();
    expect(removeEventListener).toHaveBeenCalledWith("devicechange", onChange);
  });

  it("returns undefined when mediaDevices is missing", () => {
    expect(subscribeDeviceChange(undefined, () => undefined)).toBeUndefined();
  });
});
