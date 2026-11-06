/** Install a drag's window listeners and release all of them on finish or cancel. */
export const listenForPointerDrag = (
  target: Window,
  callbacks: {
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
    cancel: () => void;
  },
): (() => void) => {
  const cleanup = () => {
    target.removeEventListener("pointermove", callbacks.move);
    target.removeEventListener("pointerup", handleUp);
    target.removeEventListener("pointercancel", handleCancel);
  };
  const handleUp = (event: PointerEvent) => {
    cleanup();
    callbacks.end(event);
  };
  const handleCancel = () => {
    cleanup();
    callbacks.cancel();
  };
  target.addEventListener("pointermove", callbacks.move);
  target.addEventListener("pointerup", handleUp, { once: true });
  target.addEventListener("pointercancel", handleCancel, { once: true });
  return cleanup;
};
