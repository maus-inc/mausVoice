import { describe, expect, it } from "vitest";
import { springSnappy } from "@desktop/styles/motion";
import { PAGE_MOTION } from "./App";

/**
 * The route-change transition is one decision (reduce-motion or not) driving
 * three props (initial / exit / transition) on the same element. These pin the
 * two presets so a later edit cannot move one prop without the other two:
 * `reduced` must never carry a y-offset (that is the slide it exists to drop)
 * and `full` must keep the 6px slide plus the app-wide springSnappy.
 */
describe("PAGE_MOTION presets", () => {
  it("full motion slides 6px in and -6px out on the shared spring", () => {
    expect(PAGE_MOTION.full.initial).toEqual({ opacity: 0, y: 6 });
    expect(PAGE_MOTION.full.exit).toEqual({ opacity: 0, y: -6 });
    expect(PAGE_MOTION.full.transition).toBe(springSnappy);
  });

  it("reduced motion cross-fades in place with no y-offset", () => {
    expect(PAGE_MOTION.reduced.initial).toEqual({ opacity: 0 });
    expect(PAGE_MOTION.reduced.exit).toEqual({ opacity: 0 });
    expect("y" in PAGE_MOTION.reduced.initial).toBe(false);
    expect("y" in PAGE_MOTION.reduced.exit).toBe(false);
    expect(PAGE_MOTION.reduced.transition).toEqual({ duration: 0.18 });
  });
});
