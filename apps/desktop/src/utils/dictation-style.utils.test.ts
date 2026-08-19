import { describe, expect, it } from "vitest";
import {
  getEffectiveToneIdAtFinalize,
  resolveInDictationArrowStyleSwitch,
  resolveNewlyPressedDictationArrow,
  toWritingStyleTransition,
  type FinalizeToneArgs,
} from "./dictation-style.utils";

const START = "polished";
const SWITCHED = "email";
const APP_TARGET = "formal";

const manual = (
  overrides: Partial<FinalizeToneArgs> = {},
): FinalizeToneArgs => ({
  stylingMode: "manual",
  toneIdAtStart: START,
  toneIdAtStop: START,
  liveSelectedToneId: START,
  appTargetToneId: APP_TARGET,
  ...overrides,
});

describe("getEffectiveToneIdAtFinalize", () => {
  it("uses the stop-time selection when the user switches before stop", () => {
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStop: SWITCHED,
          liveSelectedToneId: SWITCHED,
        }),
      ),
    ).toBe(SWITCHED);
  });

  it("uses the stop-time selection when the switch happens during a realtime segment", () => {
    // Streaming sessions skip post-processing of already-inserted text;
    // the finalize tone still follows stop-time so any non-streamed
    // leftover (and the stored label) match the newly selected profile.
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStop: SWITCHED,
          liveSelectedToneId: SWITCHED,
        }),
      ),
    ).toBe(SWITCHED);
  });

  it("ignores a switch that arrives after stop has snapshotted the tone", () => {
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStop: START,
          liveSelectedToneId: SWITCHED,
        }),
      ),
    ).toBe(START);
  });

  it("uses the app-target tone in automatic mode regardless of manual switches", () => {
    expect(
      getEffectiveToneIdAtFinalize({
        stylingMode: "app",
        toneIdAtStart: START,
        toneIdAtStop: SWITCHED,
        liveSelectedToneId: SWITCHED,
        appTargetToneId: APP_TARGET,
      }),
    ).toBe(APP_TARGET);
  });

  it("falls back to the start-time tone when the stop snapshot is missing", () => {
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStop: null,
          liveSelectedToneId: SWITCHED,
        }),
      ),
    ).toBe(START);
  });

  it("falls back to the live selection when both snapshots are missing", () => {
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStart: null,
          toneIdAtStop: null,
          liveSelectedToneId: SWITCHED,
        }),
      ),
    ).toBe(SWITCHED);
  });

  it("does not fall back to the app-target tone in manual mode", () => {
    expect(
      getEffectiveToneIdAtFinalize(
        manual({
          toneIdAtStart: null,
          toneIdAtStop: null,
          liveSelectedToneId: null,
          appTargetToneId: APP_TARGET,
        }),
      ),
    ).toBeNull();
  });
});

describe("toWritingStyleTransition", () => {
  it("maps every cycle channel to the same cycle transition", () => {
    const pill = toWritingStyleTransition({ channel: "pill", direction: 1 });
    const arrows = toWritingStyleTransition({
      channel: "arrows",
      direction: 1,
    });
    const cycleHotkey = toWritingStyleTransition({
      channel: "cycle-hotkey",
      direction: 1,
    });

    expect(pill).toEqual({ kind: "cycle", direction: 1 });
    expect(arrows).toEqual(pill);
    expect(cycleHotkey).toEqual(pill);
  });

  it("maps a style-select hotkey to a select transition", () => {
    expect(
      toWritingStyleTransition({ channel: "hotkey", toneId: SWITCHED }),
    ).toEqual({ kind: "select", toneId: SWITCHED });
  });
});

describe("resolveNewlyPressedDictationArrow", () => {
  it("returns LeftArrow when left just went down", () => {
    expect(
      resolveNewlyPressedDictationArrow(new Set(["leftarrow"]), new Set()),
    ).toBe("LeftArrow");
  });

  it("returns RightArrow when right just went down", () => {
    expect(
      resolveNewlyPressedDictationArrow(new Set(["rightarrow"]), new Set()),
    ).toBe("RightArrow");
  });

  it("returns null when the arrow was already held", () => {
    expect(
      resolveNewlyPressedDictationArrow(
        new Set(["leftarrow"]),
        new Set(["leftarrow"]),
      ),
    ).toBeNull();
  });
});

describe("resolveInDictationArrowStyleSwitch", () => {
  const ready = {
    enabled: true,
    isMainWindow: true,
    isActiveDictateSession: true,
    isManualStyling: true,
    activationHeld: true,
    newlyPressed: "RightArrow" as const,
  };

  it("cycles forward on a newly pressed RightArrow while the dictate key is held", () => {
    expect(resolveInDictationArrowStyleSwitch(ready)).toBe("forward");
  });

  it("cycles backward on a newly pressed LeftArrow while the dictate key is held", () => {
    expect(
      resolveInDictationArrowStyleSwitch({
        ...ready,
        newlyPressed: "LeftArrow",
      }),
    ).toBe("backward");
  });

  it("ignores arrows when in-dictation switching is disabled", () => {
    expect(
      resolveInDictationArrowStyleSwitch({ ...ready, enabled: false }),
    ).toBeNull();
  });

  it("ignores arrows when the dictate activation key is not held", () => {
    expect(
      resolveInDictationArrowStyleSwitch({ ...ready, activationHeld: false }),
    ).toBeNull();
  });

  it("ignores arrows outside an active manual dictate session", () => {
    expect(
      resolveInDictationArrowStyleSwitch({
        ...ready,
        isActiveDictateSession: false,
      }),
    ).toBeNull();
    expect(
      resolveInDictationArrowStyleSwitch({
        ...ready,
        isManualStyling: false,
      }),
    ).toBeNull();
  });
});
