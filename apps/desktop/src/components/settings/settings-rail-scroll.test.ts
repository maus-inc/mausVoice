// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { revealCurrentSettingsPage } from "./settings-rail-scroll";

const bounds = (left: number, right: number) => ({ left, right }) as DOMRect;

const makeRail = (left: number, right: number) => {
  const rail = document.createElement("nav");
  const current = document.createElement("a");
  current.setAttribute("aria-current", "page");
  rail.append(current);
  Object.defineProperties(rail, {
    scrollWidth: { value: 800, configurable: true },
    clientWidth: { value: 400 },
  });
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(bounds(0, 400));
  vi.spyOn(current, "getBoundingClientRect").mockReturnValue(
    bounds(left, right),
  );
  return rail;
};

describe("revealCurrentSettingsPage", () => {
  it("scrolls right only enough to expose the selected page", () => {
    const rail = makeRail(430, 500);
    revealCurrentSettingsPage(rail);
    expect(rail.scrollLeft).toBe(100);
  });

  it("scrolls left when navigating back to an earlier page", () => {
    const rail = makeRail(-50, 30);
    rail.scrollLeft = 200;
    revealCurrentSettingsPage(rail);
    expect(rail.scrollLeft).toBe(150);
  });

  it("leaves an already visible page alone", () => {
    const rail = makeRail(100, 180);
    rail.scrollLeft = 50;
    revealCurrentSettingsPage(rail);
    expect(rail.scrollLeft).toBe(50);
  });

  it("does nothing when the whole rail fits or no page is selected", () => {
    const rail = makeRail(430, 500);
    Object.defineProperty(rail, "scrollWidth", { value: 400 });
    revealCurrentSettingsPage(rail);
    expect(rail.scrollLeft).toBe(0);
    rail.firstElementChild?.remove();
    expect(() => revealCurrentSettingsPage(rail)).not.toThrow();
    expect(() => revealCurrentSettingsPage(null)).not.toThrow();
  });
});
