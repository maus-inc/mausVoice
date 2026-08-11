import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnimateSwitch } from "./AnimateIn";

describe("AnimateSwitch", () => {
  it("marks the outgoing panel inert during exit so its controls cannot fire", async () => {
    const user = userEvent.setup();
    const outgoing = jest.fn();
    const incoming = jest.fn();

    const { rerender } = render(
      <AnimateSwitch activeKey="a">
        <button type="button" onClick={outgoing}>
          from-a
        </button>
      </AnimateSwitch>,
    );

    // The active panel is interactive.
    const a = screen.getByRole("button", { name: "from-a" });
    await user.click(a);
    expect(outgoing).toHaveBeenCalledTimes(1);

    // Switch to panel b. AnimatePresence keeps the outgoing tree mounted for
    // the exit animation; PresenceGuard is responsible for inerting it.
    await act(async () => {
      rerender(
        <AnimateSwitch activeKey="b">
          <button type="button" onClick={incoming}>
            from-b
          </button>
        </AnimateSwitch>,
      );
    });

    // The incoming button is rendered and live.
    const b = screen.getByRole("button", { name: "from-b" });
    expect(b.closest("[inert]")).toBeNull();

    // Any DOM node still mounted from panel "a" must be inside an inert
    // subtree for the duration of the exit transition. Depending on timing
    // the old button may already be unmounted; if it is still around, its
    // click must be inert.
    const staleA = screen.queryByRole("button", { name: "from-a" });
    if (staleA) {
      const inertHost = staleA.closest("[inert]");
      expect(inertHost).not.toBeNull();
      // Pointer events through an inert subtree must not dispatch React
      // handlers; guard against regressions where PresenceGuard was missing
      // and the outgoing button's onClick still fired.
      await user.click(staleA);
      expect(outgoing).toHaveBeenCalledTimes(1);
    }
  });
});
