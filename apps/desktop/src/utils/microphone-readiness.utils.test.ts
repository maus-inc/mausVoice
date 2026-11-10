import { describe, expect, it } from "vitest";

import {
  DEFAULT_MICROPHONE_LINGER_MS,
  DEFAULT_MICROPHONE_PREROLL_SECONDS,
  MAX_MICROPHONE_LINGER_MS,
  MAX_MICROPHONE_PREROLL_SECONDS,
  MICROPHONE_READY_FOREVER_MS,
  classifyMicrophoneFailure,
  describeHeldState,
  isLikelyBluetoothDevice,
  lingerChoices,
  nearestLingerChoice,
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
    // the same hardware and the two would compete for it. This says "do not
    // open", not "close": the press adopts the held stream, so the caller must
    // not read `false` here as an instruction to release it.
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

/**
 * The two classifiers have to agree, because the same message is interpreted in
 * Rust for the log and here for what the user is told. A marker added to one and
 * not the other is a message that says "another application" in the snackbar and
 * "unavailable" in the log, which is worse than either alone.
 *
 * Instead of comparing a hand-copied list, this reads the marker arrays out of
 * the Rust source and asserts that both sides classify the same input the same
 * way. It is the only way the pairing can be checked without an audio device.
 */
describe("microphone failure classification", () => {
  const rust = readRepoSource(
    "apps/desktop/src-tauri/src/platform/mic_usage.rs",
  );

  const rustMarkers = (name: string): string[] => {
    const start = rust.indexOf(`const ${name}: &[&str] = &[`);
    expect(start, `${name} is missing from mic_usage.rs`).toBeGreaterThan(-1);
    const end = rust.indexOf("];", start);
    const block = rust.slice(start, end);
    // Comments inside the array quote real messages, and a quoted phrase in a
    // comment is not a marker: an early version of this extracted
    // "no longer available" out of a doc comment and asserted against it.
    const withoutComments = block.replace(/\/\/.*$/gm, "");
    return Array.from(withoutComments.matchAll(/"([^"]+)"/g)).map((match) =>
      match[1].toLowerCase(),
    );
  };

  it("knows the same in-use markers as the Rust classifier", () => {
    const markers = rustMarkers("IN_USE_MARKERS");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      // Every marker the backend recognises must reach the same conclusion here.
      expect(
        classifyMicrophoneFailure(`stream build: ${marker}`),
        `marker "${marker}" is classified differently by the frontend`,
      ).toBe("in_use_by_another_application");
    }
  });

  it("knows the same permission markers as the Rust classifier", () => {
    const markers = rustMarkers("PERMISSION_MARKERS");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(
        classifyMicrophoneFailure(`stream build: ${marker}`),
        `marker "${marker}" is classified differently by the frontend`,
      ).toBe("permission_denied");
    }
  });

  it("knows the same unavailable markers as the Rust classifier", () => {
    const markers = rustMarkers("UNAVAILABLE_MARKERS");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(
        classifyMicrophoneFailure(`stream build: ${marker}`),
        `marker "${marker}" is classified differently by the frontend`,
      ).toBe("unavailable");
    }
  });

  it("keeps the precedence the Rust side documents", () => {
    // Permission beats in-use, in-use beats unavailable. Asserted through the
    // real messages rather than the type, so reordering the checks fails here.
    expect(classifyMicrophoneFailure("device in use and access denied")).toBe(
      "permission_denied",
    );
    expect(
      classifyMicrophoneFailure(
        "device not available: device or resource busy",
      ),
    ).toBe("in_use_by_another_application");
  });

  it("does not guess at an unrecognised message", () => {
    expect(classifyMicrophoneFailure("stream build: something odd")).toBe(
      "unknown",
    );
    // A non-string is not a cause: an Error object renders as "[object Object]"
    // and an undefined renders as "undefined", and neither names a failure.
    expect(classifyMicrophoneFailure(undefined)).toBe("unknown");
    expect(classifyMicrophoneFailure(new Error("nope"))).toBe("unknown");
    expect(classifyMicrophoneFailure(null)).toBe("unknown");
  });

  it("does not stringify an object into something that looks like a cause", () => {
    // `String(message ?? "")` turned every non-string into "[object Object]",
    // and an object whose `toString` returns marker text then classified as a
    // real device failure: a wrong instruction to the user, produced by a value
    // that named nothing. Only a string is a cause.
    const liar = {
      toString: () => "device is in use by another application",
    };
    expect(String(liar)).toContain("in use");
    expect(classifyMicrophoneFailure(liar)).toBe("unknown");
    expect(classifyMicrophoneFailure(["permission denied"])).toBe("unknown");
    expect(classifyMicrophoneFailure(0)).toBe("unknown");
  });
});

describe("isLikelyBluetoothDevice", () => {
  it.each([
    ["Jabra Evolve2 65 Hands-Free", true],
    ["AirPods Pro", true],
    ["WH-1000XM5 (Bluetooth)", true],
    ["MacBook Pro Microphone", false],
    ["Yeti USB Microphone", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("%s -> %s", (label, expected) => {
    expect(isLikelyBluetoothDevice(label as string | null | undefined)).toBe(
      expected,
    );
  });

  it("is case-insensitive", () => {
    // Device names come from the OS and are capitalised inconsistently: the same
    // headset reports as "Jabra ... Hands-Free" on one host and lowercase on
    // another.
    expect(isLikelyBluetoothDevice("JABRA EVOLVE2 65 HANDS-FREE")).toBe(true);
    expect(isLikelyBluetoothDevice("bluetooth headset")).toBe(true);
  });
});

describe("lingerChoices", () => {
  it("offers every documented window, ascending", () => {
    const choices = lingerChoices();
    expect(choices).toEqual([3_000, 5_000, 15_000]);
    // Ascending so the segmented control reads left-to-right as shortest to
    // longest; an unsorted list would put "stop and think" before "a beat".
    expect([...choices]).toEqual([...choices].sort((a, b) => a - b));
  });

  it("never offers zero", () => {
    // Zero is the switch being off. A zero option would be a second control for
    // one state, and the two could disagree.
    expect(lingerChoices()).not.toContain(0);
  });

  it("stays inside the range the backend's finite-window rule covers", () => {
    for (const choice of lingerChoices()) {
      expect(choice).toBeGreaterThan(0);
      expect(choice).toBeLessThanOrEqual(MAX_MICROPHONE_LINGER_MS);
    }
  });
});

describe("nearestLingerChoice", () => {
  it.each([
    [3_000, 3_000],
    [3_400, 3_000],
    [4_100, 5_000],
    [9_900, 5_000],
    [14_000, 15_000],
    [29_999, 15_000],
    [1, 3_000],
  ])("%i ms selects %i ms", (stored, expected) => {
    expect(nearestLingerChoice(stored)).toBe(expected);
  });

  it("falls back to the default for a non-finite value", () => {
    // A NaN survives JSON round-trips as null and arrives here as NaN from a
    // hand-edited row; `Math.abs(NaN - x)` is NaN, every comparison is false,
    // and the reduce would return its seed rather than an option.
    expect(nearestLingerChoice(Number.NaN)).toBe(DEFAULT_MICROPHONE_LINGER_MS);
    expect(nearestLingerChoice(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_MICROPHONE_LINGER_MS,
    );
  });

  it("always returns one of the offered windows", () => {
    for (const stored of [0, 1, 2_999, 3_001, 12_345, 30_000, -5]) {
      expect(lingerChoices()).toContain(nearestLingerChoice(stored));
    }
  });
});
