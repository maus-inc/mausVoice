import { describe, expect, it } from "vitest";
import { createLocateGestureDetector } from "./locate-gesture.utils";

type Family = "alt" | "shift" | "control";

const tap = (
  detector: ReturnType<typeof createLocateGestureDetector>,
  key: string,
  at: number,
  allowed: Family | null,
) => {
  expect(detector.update([key], at, allowed)).toBe(false);
  return detector.update([], at + 80, allowed);
};

describe("locate gesture detector", () => {
  it("fires once for two taps of the configured family", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "Alt", 0, "alt")).toBe(false);
    expect(tap(detector, "Alt", 200, "alt")).toBe(true);
    expect(tap(detector, "Alt", 800, "alt")).toBe(false);
  });

  it("treats left and right variants as one family", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "ShiftLeft", 0, "shift")).toBe(false);
    expect(tap(detector, "ShiftRight", 200, "shift")).toBe(true);
  });

  it("rejects a second tap that starts too late", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "ControlLeft", 0, "control")).toBe(false);
    expect(tap(detector, "ControlLeft", 600, "control")).toBe(false);
  });

  it("only fires for the configured modifier", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "ShiftLeft", 0, "shift")).toBe(false);
    expect(tap(detector, "ShiftLeft", 200, "shift")).toBe(true);
    expect(tap(detector, "Alt", 400, "shift")).toBe(false);
    expect(tap(detector, "Alt", 600, "shift")).toBe(false);
  });

  it("does not fire when the gesture is disabled", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "Alt", 0, null)).toBe(false);
    expect(tap(detector, "Alt", 200, null)).toBe(false);
  });

  it("does not count a long hold as a tap", () => {
    const detector = createLocateGestureDetector();
    expect(detector.update(["Alt"], 0, "alt")).toBe(false);
    expect(detector.update([], 400, "alt")).toBe(false);
    expect(tap(detector, "Alt", 500, "alt")).toBe(false);
  });

  it("does not count a modifier held with another key", () => {
    const detector = createLocateGestureDetector();
    expect(detector.update(["Alt"], 0, "alt")).toBe(false);
    expect(detector.update(["Alt", "KeyA"], 20, "alt")).toBe(false);
    expect(detector.update(["Alt"], 60, "alt")).toBe(false);
    expect(detector.update([], 80, "alt")).toBe(false);
  });

  it("cancels when another key is pressed during the tap", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "Alt", 0, "alt")).toBe(false);
    expect(detector.update(["Alt"], 150, "alt")).toBe(false);
    expect(detector.update(["Alt", "KeyA"], 180, "alt")).toBe(false);
    expect(detector.update([], 200, "alt")).toBe(false);
    expect(tap(detector, "Alt", 300, "alt")).toBe(false);
  });

  it("cancels when a second modifier is held during the tap", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "Alt", 0, "alt")).toBe(false);
    expect(detector.update(["Alt"], 150, "alt")).toBe(false);
    expect(detector.update(["Alt", "ShiftLeft"], 180, "alt")).toBe(false);
    expect(detector.update([], 200, "alt")).toBe(false);
    expect(tap(detector, "Alt", 300, "alt")).toBe(false);
  });

  it("resets cleanly when the preference changes", () => {
    const detector = createLocateGestureDetector();
    expect(tap(detector, "Alt", 0, "alt")).toBe(false);
    detector.reset();
    expect(tap(detector, "Alt", 200, "alt")).toBe(false);
  });

  it("drops a sequence when the family changes while the key is held", () => {
    const detector = createLocateGestureDetector();
    detector.update(["Alt"], 0, "alt");
    detector.update([], 80, "alt");
    // Alt goes down again, then the preference moves to shift with Alt still
    // held, so no key snapshot arrives to notice the change.
    detector.update(["Alt"], 200, "alt");
    expect(detector.update([], 280, "shift")).toBe(false);
  });

  it("never reports a fire outside a clean pair of the configured family", () => {
    let seed = 0x335335;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const keys = ["Alt", "ShiftLeft", "ControlLeft", "KeyA"];
    const families: Family[] = ["alt", "shift", "control"];

    for (let run = 0; run < 2000; run += 1) {
      const detector = createLocateGestureDetector();
      const allowed = families[Math.floor(random() * families.length)];
      const held = new Set<string>();
      const log: { key: string; action: "press" | "release"; at: number }[] =
        [];
      let now = 0;

      for (let step = 0; step < 24; step += 1) {
        now += Math.floor(random() * 220);
        const key = keys[Math.floor(random() * keys.length)];
        const wantPress = !held.has(key) && (held.size === 0 || random() < 0.5);
        if (wantPress) {
          held.add(key);
          log.push({ key, action: "press", at: now });
        } else if (held.has(key)) {
          held.delete(key);
          log.push({ key, action: "release", at: now });
        }

        const fired = detector.update(Array.from(held), now, allowed);
        if (!fired) continue;

        const recent = log.slice(-4);
        expect(recent.map((entry) => entry.action)).toEqual([
          "press",
          "release",
          "press",
          "release",
        ]);
        const family = (key: string) =>
          key.toLowerCase().startsWith("alt")
            ? "alt"
            : key.toLowerCase().startsWith("shift")
              ? "shift"
              : key.toLowerCase().startsWith("control")
                ? "control"
                : null;
        expect(family(recent[0].key)).toBe(allowed);
        expect(family(recent[2].key)).toBe(allowed);
        expect(recent[1].at - recent[0].at).toBeLessThanOrEqual(350);
        expect(recent[3].at - recent[2].at).toBeLessThanOrEqual(350);
        expect(recent[2].at - recent[1].at).toBeLessThanOrEqual(400);
        log.length = 0;
      }
    }
  });
});
