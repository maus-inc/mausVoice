import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { showErrorSnackbar } from "../../actions/app.actions";
import { isTauriRuntime } from "../../utils/env.utils";
import { getPlatform, type Platform } from "../../utils/platform.utils";
import {
  grabPoint,
  restoredPosition,
  type RestoreGrab,
} from "../../utils/window-drag.utils";

type DragPoint = { x: number; y: number };

type TauriWindow = ReturnType<typeof getCurrentWindow>;

/**
 * Minimum pointer travel in CSS pixels before a primary-button press on the
 * title bar hands off to `win.startDragging()`.
 *
 * Tauri's injected `drag.js` invokes `plugin:window|start_dragging` on the very
 * first `mousedown` (`detail === 1`) before the pointer has moved. On
 * undecorated windows (`decorations: false`) that immediate OS move loop
 * (1) unmaximizes a maximized window while leaving it at full-screen width
 * (tauri#11945), (2) swallows the first `mouseup` on Windows/Linux so the
 * browser never synthesizes `dblclick` (tauri#10767), and (3) on `detail === 2`
 * invokes `internal_toggle_maximize` right before `onDoubleClick` fires
 * `toggleMax`, toggling maximize twice and canceling out.
 */
const DRAG_START_DISTANCE_PX = 4;

/**
 * Upper bound in ms on waiting for the restored window to report its new size.
 *
 * A restore lands within a frame or two on every platform this ships on, so this
 * only fires when no resize event is coming at all. It is a fallback for a
 * missing signal, not the ordering guarantee itself, which is the event.
 */
const RESTORE_SETTLE_TIMEOUT_MS = 500;

const isPrimaryButtonHeld = (buttons: number): boolean => (buttons & 1) !== 0;

const isWithinDragThreshold = (
  origin: DragPoint,
  clientX: number,
  clientY: number,
): boolean =>
  Math.hypot(clientX - origin.x, clientY - origin.y) < DRAG_START_DISTANCE_PX;

/**
 * Whether the press goes through the deferred handoff below.
 *
 * macOS starts the move on the press itself: `tao` passes `NSApp.currentEvent()`
 * to `performWindowDragWithEvent:`, and AppKit waits for pointer movement
 * before it moves anything, so the deferral has nothing to protect there. It is
 * also AppKit that restores a zoomed window and keeps it under the pointer, so
 * the manual restore below is Windows and Linux only.
 */
const defersNativeDrag = (platform: Platform): boolean => platform !== "macos";

/**
 * Where the pointer grabbed the title bar, as a fraction of the window.
 *
 * The browser reports the press in CSS pixels inside the window's client area,
 * and the client area is the whole window on an undecorated shell. That makes
 * the press an offset from the window's own top-left corner, which is what a
 * fraction needs, so where the window sits on the desktop is not part of this
 * measurement. Only the unit has to change: `innerSize` is physical, so the
 * press is scaled up by the window's own scale factor.
 */
const readGrab = async (
  win: TauriWindow,
  press: DragPoint,
): Promise<RestoreGrab | null> => {
  try {
    const [size, scale] = await Promise.all([
      win.innerSize(),
      win.scaleFactor(),
    ]);
    const factor = scale || 1;
    // The press is an offset inside the window, not a point on the desktop, so
    // the window's own position plays no part. It only has to be converted from
    // CSS pixels to the physical pixels `innerSize` is reported in.
    return grabPoint(
      { x: press.x * factor, y: press.y * factor },
      { width: size.width, height: size.height },
    );
  } catch {
    return null;
  }
};

/**
 * Settles once the restore has actually changed the window, bounded by a
 * timeout.
 *
 * `unmaximize()` resolving is not proof that the window is restored. On Windows
 * `tao` posts `set_maximized(false)` to the event-loop thread, so the command
 * returns while the resize is still queued, and a size read straight after it
 * can still return the maximized geometry. The resize event is the observable
 * that says the window now has its restored size.
 *
 * The subscription is made before the restore is requested, because
 * `onResized` only listens from now on and does not replay a resize that has
 * already happened. Waiting for the event before asking for the restore is what
 * makes a fast restore impossible to miss.
 */
const armRestoreWait = (win: TauriWindow) => {
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let resolveSettled: () => void = () => undefined;
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeoutId);
    unsubscribe?.();
    resolveSettled();
  };
  // The timeout is the fallback for a platform that never emits the event; it
  // is not the ordering guarantee, which is the event itself.
  const timeoutId = window.setTimeout(finish, RESTORE_SETTLE_TIMEOUT_MS);
  const subscribed = win
    .onResized(finish)
    .then((stop) => {
      // A resize can land before the listener is registered. The wait is
      // already over in that case, so drop the subscription rather than
      // leaving a listener behind.
      if (settled) stop();
      else unsubscribe = stop;
    })
    .catch(finish);

  return {
    /** Resolves when the window has resized, or when the fallback expires. */
    wait: async () => {
      await subscribed;
      await settledPromise;
    },
    /** Releases the listener when the restore itself failed. */
    stop: finish,
  };
};

/**
 * The logical position that puts the grab point back under the pointer.
 *
 * Returns `null` when the window or the pointer cannot be measured, which the
 * caller reports and continues from.
 */
const readRestoreTarget = async (
  win: TauriWindow,
  grab: RestoreGrab,
): Promise<LogicalPosition | null> => {
  try {
    // All four of these are physical pixels, so they combine directly. The
    // result stays physical and is converted to the logical position
    // `setPosition` takes, which is the one place the two spaces meet.
    const [size, pointer, scale] = await Promise.all([
      win.innerSize(),
      cursorPosition(),
      win.scaleFactor(),
    ]);
    const monitor = await monitorUnderPointer(pointer);
    const target = restoredPosition(
      grab,
      size,
      pointer,
      monitor?.workArea.position ?? { x: 0, y: 0 },
    );
    const factor = scale || 1;
    return new LogicalPosition(target.x / factor, target.y / factor);
  } catch {
    return null;
  }
};

/**
 * The monitor whose work area contains the pointer, falling back to the
 * window's own monitor.
 *
 * `currentMonitor()` reports where the window is, and a restored window is
 * placed under the pointer. When the press happens on a maximized window that
 * spans two displays, the pointer can be on the other one, and the top clamp
 * would then use an origin from a monitor the window is not being dragged onto.
 * Enumerating is best effort: a host that cannot list monitors keeps the
 * window's own.
 */
const monitorUnderPointer = async (pointer: { x: number; y: number }) => {
  const own = await currentMonitor();
  try {
    const monitors = await availableMonitors();
    const under = monitors.find((monitor) => {
      const { position, size } = monitor.workArea;
      return (
        pointer.x >= position.x &&
        pointer.x < position.x + size.width &&
        pointer.y >= position.y &&
        pointer.y < position.y + size.height
      );
    });
    return under ?? own;
  } catch {
    return own;
  }
};

/**
 * Reads the live maximize state, for a press that landed before the bar's own
 * first measurement. A failed read is treated as not maximized, which degrades
 * to the old plain drag rather than skipping the restore the person expected.
 */
const readMaximized = (win: TauriWindow) =>
  win.isMaximized().catch(() => false);

const startWindowDrag = (win: TauriWindow) =>
  win.startDragging().catch(showErrorSnackbar);

/**
 * Puts the restored window under the grab point, if it can be measured.
 *
 * A window that cannot be placed is still a window the person is dragging, so
 * every failure here is reported and swallowed. The gesture then continues from
 * wherever the OS restored it, which is worse than intended but far better than
 * a drag that stops dead under the pointer.
 */
const placeRestoredWindow = async (win: TauriWindow, grab: RestoreGrab) => {
  try {
    const target = await readRestoreTarget(win, grab);
    if (target !== null) await win.setPosition(target);
  } catch (error) {
    showErrorSnackbar(error);
  }
};

type Gesture = {
  win: TauriWindow;
  /** Primary press that started the gesture, in window CSS pixels. */
  origin: DragPoint;
  /** Whether the press landed on a maximized window. */
  maximized: boolean;
  /**
   * Set when the bar had no measurement yet at press time, so `maximized` is a
   * placeholder rather than a reading. The restore decides on a live query.
   */
  maximizedUnknown: boolean;
  /** Set once the gesture has committed to restoring, so it happens once. */
  restored: boolean;
  /**
   * Set when the pointer is released while the restore is still in flight.
   *
   * The press's own listeners are torn down when the restore starts, so a
   * release during the restore would otherwise be invisible and the window
   * would begin moving after the button was already up.
   */
  released: boolean;
};

/**
 * Restores a maximized window under the pointer, then continues the drag.
 *
 * Both platforms need the restore done by hand. On Windows `tao` posts
 * `WM_NCLBUTTONDOWN(HTCAPTION)` for `drag_window`, and that path restores a
 * maximized window without keeping the grab point on the bar, so the restored
 * window lands wherever its saved rectangle was. On Linux the move goes to
 * `gdk_window_begin_move_drag`, and the compositor owns where a restored window
 * lands.
 *
 * The grab point is measured on the maximized window, before the restore, which
 * is the geometry the press was made against. The placement is measured after
 * it, so the window is put under the pointer at the size it actually has now.
 * The move is then handed to the OS from that position, so the rest of the
 * gesture follows the pointer without this side re-measuring it.
 */
const restoreAndDrag = async (gesture: Gesture) => {
  const { win } = gesture;
  // Armed immediately before the restore is requested, not at the top: the
  // settle allowance is measured from the request, so writing it on early and
  // then spending it on two native reads would let the timer expire first and
  // place the window against pre-restore geometry.
  let restore: ReturnType<typeof armRestoreWait> | null = null;
  try {
    if (gesture.maximizedUnknown) gesture.maximized = await readMaximized(win);
    if (!gesture.maximized) {
      // Measured after the press: the window is not maximized after all, so
      // this is an ordinary drag and nothing needs restoring.
      if (!gesture.released) await startWindowDrag(win);
      return;
    }
    const grab = await readGrab(win, gesture.origin);
    if (grab === null) {
      // Still a drag the person is making; just not one this side can place.
      if (!gesture.released) await startWindowDrag(win);
      return;
    }
    restore = armRestoreWait(win);
    await win.unmaximize();
    await restore.wait();
    if (gesture.released) return;
    await placeRestoredWindow(win, grab);
    if (gesture.released) return;
    await startWindowDrag(win);
  } catch (error) {
    // A failed restore must not leave its listener armed for the next one.
    restore?.stop();
    showErrorSnackbar(error);
  }
};

/**
 * Watches a pending press and hands the gesture to the OS once it is a drag.
 *
 * Both listeners are signal-scoped, so a release, a lost button and a window
 * blur all tear the watch down. A gesture that has not committed to a restore
 * by then stays a click, which is what keeps double-click on a maximized bar
 * toggling instead of restoring.
 */
const bindDeferredDrag = (
  gesture: Gesture,
  cleanupRef: React.MutableRefObject<(() => void) | null>,
) => {
  const controller = new AbortController();
  const cleanup = () => {
    controller.abort();
    if (cleanupRef.current === cleanup) {
      cleanupRef.current = null;
    }
  };

  const handleMove = (moveEvent: MouseEvent) => {
    if (!isPrimaryButtonHeld(moveEvent.buttons)) {
      cleanup();
      return;
    }
    if (
      isWithinDragThreshold(
        gesture.origin,
        moveEvent.clientX,
        moveEvent.clientY,
      )
    ) {
      return;
    }
    cleanup();
    // A maximized window is never handed to the OS move loop as it stands.
    // `drag_window` posts `WM_NCLBUTTONDOWN(HTCAPTION)` on Windows, and that
    // restores the window at its saved rectangle rather than keeping the grab
    // point on the bar, so the gesture restores first and then hands over.
    if ((gesture.maximized || gesture.maximizedUnknown) && !gesture.restored) {
      gesture.restored = true;
      // The press's listeners go away with `cleanup()`, so the release that
      // ends the gesture has to be watched for separately: a restore that lands
      // after the button came up must not start moving the window.
      const watchRelease = new AbortController();
      // A blur means the interaction is over even though no button came up,
      // and a secondary button release must not cancel a primary drag.
      const release = (event?: MouseEvent) => {
        if (event && event.button !== 0) return;
        gesture.released = true;
        watchRelease.abort();
      };
      window.addEventListener("mouseup", release, {
        capture: true,
        signal: watchRelease.signal,
      });
      window.addEventListener("blur", () => release(), {
        signal: watchRelease.signal,
      });
      restoreAndDrag(gesture)
        .catch(showErrorSnackbar)
        .finally(() => {
          watchRelease.abort();
        });
      return;
    }
    startWindowDrag(gesture.win);
  };

  cleanupRef.current = cleanup;
  window.addEventListener("mousemove", handleMove, {
    signal: controller.signal,
  });
  window.addEventListener("mouseup", cleanup, {
    capture: true,
    signal: controller.signal,
  });
  window.addEventListener("blur", cleanup, {
    signal: controller.signal,
  });
};

/**
 * Arms the skip window that keeps a mac `mouseup(detail === 2)` from also
 * toggling through the `dblclick` WebKit may still synthesize.
 *
 * The flag lives across the current dispatch and clears on the next macrotask,
 * so it outlives the microtasks between the two events yet expires if no
 * `dblclick` is dispatched.
 */
const armSingleTurnDblClickSkip = (
  skipRef: React.MutableRefObject<boolean>,
) => {
  skipRef.current = true;
  window.setTimeout(() => {
    skipRef.current = false;
  }, 0);
};

/**
 * Whether a `mouseup` is the second release of a mac double-click.
 *
 * On macOS `performWindowDragWithEvent:` on the first press consumes the first
 * `mouseup` in AppKit, so WebKit may not synthesize `dblclick` on the second
 * release even though `mouseup` arrives with `detail === 2`.
 */
const isMacDoubleClickRelease = (
  detail: number,
  origin: DragPoint | null,
  clientX: number,
  clientY: number,
): boolean =>
  getPlatform() === "macos" &&
  detail === 2 &&
  origin !== null &&
  isWithinDragThreshold(origin, clientX, clientY);

export type TitleBarDragHandlers = {
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseUp: (event: React.MouseEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
};

/**
 * Title-bar pointer gestures: drag, drag-to-restore and double-click.
 *
 * The hook owns the listeners and their cleanup, so the bar only renders the
 * props. Maximize state and its sequence guards stay with the caller, which
 * reads `maximizedRef` here because a press has to see the value as it stands
 * at that press, not as it stood at the last render.
 */
export const useWindowDrag = (
  maximizedRef: React.MutableRefObject<boolean | undefined>,
  toggleMaximized: () => void,
): TitleBarDragHandlers => {
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const skipNextDblClickRef = useRef(false);
  const doubleClickOriginRef = useRef<DragPoint | null>(null);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Prevent text selection on double-click and stop propagation before the
      // event bubbles from the React root to `document`, where Tauri's injected
      // `drag.js` listener lives.
      event.preventDefault();
      event.stopPropagation();
      dragCleanupRef.current?.();
      skipNextDblClickRef.current = false;

      // The second press of a double-click is handled by `onDoubleClick` (or
      // `onMouseUp` on macOS); never start a drag on a multi-click.
      if (event.detail >= 2) {
        doubleClickOriginRef.current = { x: event.clientX, y: event.clientY };
        return;
      }
      doubleClickOriginRef.current = null;
      if (!isTauriRuntime()) return;

      const gesture: Gesture = {
        win: getCurrentWindow(),
        origin: { x: event.clientX, y: event.clientY },
        maximized: maximizedRef.current ?? false,
        maximizedUnknown: maximizedRef.current === undefined,
        restored: false,
        released: false,
      };
      if (!defersNativeDrag(getPlatform())) {
        startWindowDrag(gesture.win);
        return;
      }
      bindDeferredDrag(gesture, dragCleanupRef);
    },
    [maximizedRef],
  );

  const onMouseUp = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // On macOS, Tauri's `drag.js` invokes `internal_toggle_maximize` from a
      // document-level `mouseup` listener when `detail === 2`. Stopping
      // propagation here prevents `drag.js` from double-toggling.
      event.stopPropagation();
      dragCleanupRef.current?.();
      const origin = doubleClickOriginRef.current;
      doubleClickOriginRef.current = null;
      if (
        isMacDoubleClickRelease(
          event.detail,
          origin,
          event.clientX,
          event.clientY,
        )
      ) {
        armSingleTurnDblClickSkip(skipNextDblClickRef);
        toggleMaximized();
      }
    },
    [toggleMaximized],
  );

  const onDoubleClick = useCallback(() => {
    if (skipNextDblClickRef.current) {
      skipNextDblClickRef.current = false;
      return;
    }
    toggleMaximized();
  }, [toggleMaximized]);

  return { onMouseDown, onMouseUp, onDoubleClick };
};
