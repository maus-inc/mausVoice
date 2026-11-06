import { describe, expect, it } from "vitest";

import {
  DEFAULT_MICROPHONE_PREROLL_SECONDS,
  MAX_MICROPHONE_PREROLL_SECONDS,
  MICROPHONE_READY_FOREVER_MS,
  describeHeldState,
  normalizeMicrophonePrerollSeconds,
  shouldHoldMicrophoneReady,
  shouldPrepareMicrophone,
} from "./microphone-readiness.utils";
import { readRepoSource } from "../../test/helpers/rust-source.utils";

/**
 * The pre-roll reaches the recorder as a sample count computed in the command
 * layer, and both that layer and the recording backend clamp it again. If those
 * limits disagree, the slider silently stops meaning what its label says, so the
 * caps are asserted against the Rust source instead of trusted to stay in step.
 */
describe("microphone pre-roll limits", () => {
  it("matches the cap the command layer clamps to", () => {
    const source = readRepoSource("apps/desktop/src-tauri/src/commands.rs");
    const match = source.match(/const MAX_PREROLL_SECONDS: f64 = ([0-9.]+);/);

    expect(
      match,
      "MAX_PREROLL_SECONDS is missing from commands.rs",
    ).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_MICROPHONE_PREROLL_SECONDS);
  });

  it("never asks the recorder for more than it will keep", () => {
    // The slider tops out at the same two seconds, so a value it can produce is
    // never silently reduced on the way to the device.
    expect(normalizeMicrophonePrerollSeconds(3)).toBe(
      MAX_MICROPHONE_PREROLL_SECONDS,
    );
    expect(
      normalizeMicrophonePrerollSeconds(MAX_MICROPHONE_PREROLL_SECONDS),
    ).toBe(MAX_MICROPHONE_PREROLL_SECONDS);
  });

  it("falls back to the default for a missing or nonsense value", () => {
    // A profile written before this setting existed has no value at all, and a
    // hand-edited one can hold anything. Neither should reach the device.
    expect(normalizeMicrophonePrerollSeconds(undefined)).toBe(
      DEFAULT_MICROPHONE_PREROLL_SECONDS,
    );
    expect(normalizeMicrophonePrerollSeconds(null)).toBe(
      DEFAULT_MICROPHONE_PREROLL_SECONDS,
    );
    expect(normalizeMicrophonePrerollSeconds(Number.NaN)).toBe(
      DEFAULT_MICROPHONE_PREROLL_SECONDS,
    );
    expect(normalizeMicrophonePrerollSeconds(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_MICROPHONE_PREROLL_SECONDS,
    );
  });

  it("keeps zero, which is a real choice and not a missing value", () => {
    // Zero means "hold the device ready but keep no audio". Treating it as
    // absent would silently turn the pre-roll back on.
    expect(normalizeMicrophonePrerollSeconds(0)).toBe(0);
    expect(normalizeMicrophonePrerollSeconds(-1)).toBe(0);
  });
});

describe("the ready-forever window", () => {
  it("is read as no timer by the recorder", () => {
    const audio = readRepoSource(
      "apps/desktop/src-tauri/src/platform/audio.rs",
    );

    // The recorder treats its own maximum as "hold until closed" and anything
    // smaller as a real window, so the component has to send a value at or
    // above that sentinel's floor rather than a plausible few seconds.
    expect(audio).toContain("const WARM_FOREVER_MS: u64 = u64::MAX;");
    expect(MICROPHONE_READY_FOREVER_MS).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is what the component actually sends", () => {
    const component = readRepoSource(
      "apps/desktop/src/components/root/MicrophoneReadinessSideEffects.tsx",
    );

    // Sending a finite window from the keep-ready path would make an
    // always-ready microphone close itself while the preference says it is on.
    expect(component).toContain("MICROPHONE_READY_FOREVER_MS");
    expect(component).not.toMatch(/warmMicrophone\([^)]*5_000/);
  });

  it("survives the trip through the command layer", () => {
    const source = readRepoSource("apps/desktop/src-tauri/src/commands.rs");

    // `Number.MAX_SAFE_INTEGER` is 9.007e15, so the threshold that turns it
    // into the sentinel has to be at or below that magnitude.
    const match = source.match(/linger_ms >= ([0-9.e]+)/);
    expect(match, "the sentinel threshold is missing").not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("when the microphone is held", () => {
  const base = {
    enabled: true,
    isRecording: false,
    isLocalDataClearing: false,
    permissionGranted: true,
  };

  it("holds when the preference is on and nothing blocks it", () => {
    expect(shouldHoldMicrophoneReady(base)).toBe(true);
  });

  it("never holds while a recording is running", () => {
    // The recording owns the device; a second hold would open another stream on
    // the same hardware and the two would compete for it.
    expect(shouldHoldMicrophoneReady({ ...base, isRecording: true })).toBe(
      false,
    );
  });

  it("releases while local data is being cleared", () => {
    // The clear deletes the captured audio, so a microphone still running
    // through it is live for nothing.
    expect(
      shouldHoldMicrophoneReady({ ...base, isLocalDataClearing: true }),
    ).toBe(false);
  });

  it("does not open a device the OS has not authorised", () => {
    // A revoked permission must not leave a stream running, and asking the
    // backend to open one would surface an error for a preference already set.
    expect(
      shouldHoldMicrophoneReady({ ...base, permissionGranted: false }),
    ).toBe(false);
  });

  it("does nothing when the preference is off", () => {
    expect(shouldHoldMicrophoneReady({ ...base, enabled: false })).toBe(false);
  });
});

describe("when the device is prepared", () => {
  const base = {
    isRecording: false,
    isLocalDataClearing: false,
    permissionGranted: true,
    holdActive: false,
  };

  it("prepares when nothing is held", () => {
    expect(shouldPrepareMicrophone(base)).toBe(true);
  });

  it("does not repeat work the hold already did", () => {
    // A held stream resolved the device when it opened, so preparing again would
    // only enumerate and score the same list twice.
    expect(shouldPrepareMicrophone({ ...base, holdActive: true })).toBe(false);
  });

  it("does not prepare during a recording or a clear", () => {
    expect(shouldPrepareMicrophone({ ...base, isRecording: true })).toBe(false);
    expect(
      shouldPrepareMicrophone({ ...base, isLocalDataClearing: true }),
    ).toBe(false);
  });
});

describe("the held caption", () => {
  it("says nothing before the backend has answered", () => {
    // `null` is "not read yet", which is different from "not held". Claiming
    // either before the first read would tell the user something the app does
    // not know.
    expect(describeHeldState(null)).toBe("unknown");
  });

  it("distinguishes a held device from a released one", () => {
    expect(describeHeldState(true)).toBe("held");
    expect(describeHeldState(false)).toBe("not_held");
  });
});
