import { describe, expect, it } from "vitest";
import {
  cssEase,
  duration,
  easeInOutCubic,
  easeOutCubic,
  easeOutQuint,
  emphasisTransition,
  enterTransition,
  exitTransition,
  fadeVariants,
  layoutTransition,
  pressScale,
  pressTransition,
  riseVariants,
  springSnappy,
  springSoft,
} from "./motion";

describe("motion profiles", () => {
  it("keeps the easing curves in the expected order", () => {
    expect([...easeOutQuint]).toEqual([0.23, 1, 0.32, 1]);
    expect([...easeOutCubic]).toEqual([0.33, 1, 0.68, 1]);
    expect([...easeInOutCubic]).toEqual([0.645, 0.045, 0.355, 1]);
  });

  it("builds css easing strings from the token arrays", () => {
    expect(cssEase(easeOutQuint)).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
    expect(cssEase(easeOutCubic)).toBe("cubic-bezier(0.33, 1, 0.68, 1)");
  });

  it("keeps press feedback short and subtle", () => {
    expect(pressScale).toBeGreaterThanOrEqual(0.95);
    expect(pressScale).toBeLessThan(1);
    expect(pressTransition).toMatchObject({ duration: duration.instant });
  });

  it("pairs enter and exit variants symmetrically", () => {
    expect(riseVariants.hidden).toMatchObject({ opacity: 0, scale: 0.99 });
    expect(riseVariants.shown).toMatchObject({ opacity: 1, y: 0, scale: 1 });
    expect(riseVariants.gone).toMatchObject({ opacity: 0, scale: 0.99 });
    expect(enterTransition).toBe(springSnappy);
    expect(exitTransition).toMatchObject({ duration: duration.exit });
  });

  it("keeps the fade variants free of translation and scale", () => {
    expect(fadeVariants.hidden).toEqual({ opacity: 0 });
    expect(fadeVariants.shown).toEqual({ opacity: 1 });
    expect(fadeVariants.gone).toEqual({ opacity: 0 });
  });

  it("drives layout continuity and emphasis with springs", () => {
    expect(layoutTransition).toBe(springSoft);
    expect(emphasisTransition).toMatchObject({ type: "spring" });
  });
});
