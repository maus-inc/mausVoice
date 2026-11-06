import { describe, expect, it } from "vitest";
import {
  advanceHotkeyCapture,
  hasNewHeldKeys,
  uniqueHeldKeys,
} from "./hotkey-capture.utils";

describe("hotkey capture", () => {
  it("deduplicates held keys without changing order or casing", () => {
    expect(
      uniqueHeldKeys(["ControlLeft", "KeyA", "ControlLeft", "keya"]),
    ).toEqual(["ControlLeft", "KeyA", "keya"]);
  });

  it("records additions and replacements but not releases or reorderings", () => {
    expect(hasNewHeldKeys(["ControlLeft", "KeyA"], ["ControlLeft"])).toBe(true);
    expect(
      hasNewHeldKeys(["ControlLeft", "KeyB"], ["ControlLeft", "KeyA"]),
    ).toBe(true);
    expect(hasNewHeldKeys(["ControlLeft"], ["ControlLeft", "KeyA"])).toBe(
      false,
    );
    expect(
      hasNewHeldKeys(["KeyA", "ControlLeft"], ["ControlLeft", "KeyA"]),
    ).toBe(false);
    expect(hasNewHeldKeys([], [])).toBe(false);
  });

  it("tracks recording, replacement, release and cancellation snapshots", () => {
    const base = {
      focused: true,
      interacted: false,
      keysHeld: [],
      previousHeld: [],
      lastEmitted: ["Old"],
    };
    expect(
      advanceHotkeyCapture({ ...base, focused: false, previousHeld: ["Old"] }),
    ).toEqual({ action: "idle", previousHeld: [], lastEmitted: ["Old"] });
    expect(advanceHotkeyCapture(base)).toEqual({
      action: "idle",
      previousHeld: [],
      lastEmitted: [],
    });
    expect(
      advanceHotkeyCapture({
        ...base,
        keysHeld: ["ControlLeft", "ControlLeft"],
      }),
    ).toEqual({
      action: "record",
      previousHeld: ["ControlLeft"],
      lastEmitted: ["ControlLeft"],
      emitted: ["ControlLeft"],
    });
    expect(
      advanceHotkeyCapture({
        ...base,
        interacted: true,
        keysHeld: ["ControlLeft", "KeyA"],
        previousHeld: ["ControlLeft"],
        lastEmitted: ["ControlLeft"],
      }),
    ).toEqual({
      action: "record",
      previousHeld: ["ControlLeft", "KeyA"],
      lastEmitted: ["ControlLeft", "KeyA"],
      emitted: ["ControlLeft", "KeyA"],
    });
    expect(
      advanceHotkeyCapture({
        ...base,
        interacted: true,
        keysHeld: ["KeyA", "ControlLeft"],
        previousHeld: ["ControlLeft", "KeyA"],
        lastEmitted: ["ControlLeft", "KeyA"],
      }),
    ).toEqual({
      action: "record",
      previousHeld: ["KeyA", "ControlLeft"],
      lastEmitted: ["ControlLeft", "KeyA"],
      emitted: undefined,
    });
    expect(
      advanceHotkeyCapture({
        ...base,
        interacted: true,
        keysHeld: ["ControlLeft"],
        previousHeld: ["ControlLeft", "KeyA"],
        lastEmitted: ["ControlLeft", "KeyA"],
      }),
    ).toEqual({
      action: "release",
      released: ["ControlLeft", "KeyA"],
      previousHeld: [],
      lastEmitted: ["ControlLeft", "KeyA"],
    });
    expect(advanceHotkeyCapture({ ...base, keysHeld: ["Escape"] })).toEqual({
      action: "cancel",
      previousHeld: ["Escape"],
      lastEmitted: [],
    });
  });
});
