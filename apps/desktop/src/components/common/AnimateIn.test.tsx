// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnimateSwitch } from "./AnimateIn";

// jsdom lacks matchMedia; framer-motion's useReducedMotion queries it.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("AnimateSwitch", () => {
  it("inerts the outgoing panel during exit so its controls cannot fire", async () => {
    const outgoing = vi.fn();
    const incoming = vi.fn();

    const { rerender } = render(
      <AnimateSwitch activeKey="a">
        <button type="button" onClick={outgoing}>
          from-a
        </button>
      </AnimateSwitch>,
    );

    // The active panel is fully interactive.
    screen.getByRole("button", { name: "from-a" }).click();
    expect(outgoing).toHaveBeenCalledTimes(1);

    act(() => {
      rerender(
        <AnimateSwitch activeKey="b">
          <button type="button" onClick={incoming}>
            from-b
          </button>
        </AnimateSwitch>,
      );
    });

    // mode="wait" runs the exit first, so panel a can still be mounted here.
    // While it is, it must sit inside an inert + aria-hidden + click-proof
    // subtree. (byRole can't see it — aria-hidden subtrees leave the a11y
    // tree — so query by text instead.)
    const staleA = screen.queryByText("from-a");
    if (staleA) {
      const guard = staleA.closest("[inert]") as HTMLElement | null;
      expect(guard).not.toBeNull();
      expect(guard?.getAttribute("aria-hidden")).toBe("true");
      expect(guard?.style.pointerEvents).toBe("none");
    }

    // The incoming panel mounts live after the exit completes.
    const b = await screen.findByRole("button", { name: "from-b" });
    expect(b.closest("[inert]")).toBeNull();
    b.click();
    expect(incoming).toHaveBeenCalledTimes(1);

    // The outgoing panel's handler never fired again.
    expect(outgoing).toHaveBeenCalledTimes(1);
  });
});
