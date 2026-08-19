import { describe, expect, it } from "vitest";
import {
  doesLateStyleSwitchAffectCurrentUtterance,
  getEffectiveToneIdAtFinalize,
  resolveInDictationArrowStyleSwitch,
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
    const decision = getEffectiveToneIdAtFinalize(
      manual({
        toneIdAtStop: SWITCHED,
        liveSelectedToneId: SWITCHED,
      }),
    );
    expect(decision.toneId).toBe(SWITCHED);
    expect(decision.restyleInsertedText).toBe(false);
  });

  it("uses the stop-time selection when the switch happens during a realtime segment", () => {
    // Already-inserted interim text is never rewritten; the finalize tone
    // still follows the stop-time selection so any non-streamed leftover
    // (and the stored label) match the newly selected profile.
    const decision = getEffectiveToneIdAtFinalize(
      manual({
        toneIdAtStop: SWITCHED,
        liveSelectedToneId: SWITCHED,
        hasInsertedInterimText: true,
      }),
    );
    expect(decision.toneId).toBe(SWITCHED);
    expect(decision.restyleInsertedText).toBe(false);
  });

  it("ignores a switch that arrives after stop has snapshotted the tone", () => {
    const decision = getEffectiveToneIdAtFinalize(
      manual({
        toneIdAtStop: START,
        liveSelectedToneId: SWITCHED,
      }),
    );
    expect(decision.toneId).toBe(START);
    expect(decision.restyleInsertedText).toBe(false);
  });

  it("uses the app-target tone in automatic mode regardless of manual switches", () => {
    const decision = getEffectiveToneIdAtFinalize({
      stylingMode: "app",
      toneIdAtStart: START,
      toneIdAtStop: SWITCHED,
      liveSelectedToneId: SWITCHED,
      appTargetToneId: APP_TARGET,
    });
    expect(decision.toneId).toBe(APP_TARGET);
    expect(decision.restyleInsertedText).toBe(false);
  });

  it("falls back to the start-time tone when the stop snapshot is missing", () => {
    const decision = getEffectiveToneIdAtFinalize(
      manual({
        toneIdAtStop: null,
        liveSelectedToneId: SWITCHED,
      }),
    );
    expect(decision.toneId).toBe(START);
  });
});

describe("doesLateStyleSwitchAffectCurrentUtterance", () => {
  it("lets a switch before the stop snapshot win", () => {
    expect(doesLateStyleSwitchAffectCurrentUtterance(false)).toBe(true);
  });

  it("lets the stop snapshot win when a switch arrives during finalize", () => {
    expect(doesLateStyleSwitchAffectCurrentUtterance(true)).toBe(false);
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
