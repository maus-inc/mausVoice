// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { listenForPointerDrag } from "./pointer-drag-listeners";

const fire = (name: string) => window.dispatchEvent(new Event(name));

describe("listenForPointerDrag", () => {
  it.each(["pointerup", "pointercancel"])(
    "removes all listeners before %s callback",
    (terminal) => {
      const move = vi.fn();
      const end = vi.fn(() => fire("pointermove"));
      const cancel = vi.fn(() => fire("pointermove"));
      listenForPointerDrag(window, { move, end, cancel });
      fire("pointermove");
      fire(terminal);
      fire("pointermove");
      fire("pointerup");
      fire("pointercancel");
      expect(move).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledTimes(terminal === "pointerup" ? 1 : 0);
      expect(cancel).toHaveBeenCalledTimes(
        terminal === "pointercancel" ? 1 : 0,
      );
    },
  );

  it("can be disposed before the pointer ends, without committing or cancelling", () => {
    const callbacks = { move: vi.fn(), end: vi.fn(), cancel: vi.fn() };
    const dispose = listenForPointerDrag(window, callbacks);
    dispose();
    dispose();
    fire("pointermove");
    fire("pointerup");
    fire("pointercancel");
    expect(callbacks.move).not.toHaveBeenCalled();
    expect(callbacks.end).not.toHaveBeenCalled();
    expect(callbacks.cancel).not.toHaveBeenCalled();
  });
});
