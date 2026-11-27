import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
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
 * Where the pointer grabbed the title bar, in window coordinates.
 *
 * The browser reports the press in CSS pixels inside the window's client area,
 * and the client area is the whole window on an undecorated shell. The window's
 * own origin is read rather than assumed, because a maximized window is not
 * necessarily at `(0, 0)` on a multi-monitor desktop.
 */
const readGrab = async (
  win: TauriWindow,
  press: DragPoint,
): Promise<RestoreGrab | null> => {
  try {
    const [origin, size] = await Promise.all([
      win.innerPosition(),
      win.innerSize(),
    ]);
    return grabPoint(
      { x: press.x + origin.x, y: press.y + origin.y },
      { width: size.width, height: size.height },
    );
  } catch {
    return null;
  }
};

const readRestoreTarget = async (
  win: TauriWindow,
  grab: RestoreGrab,
): Promise<DragPoint | null> => {
  try {
    // The pointer is read in physical pixels while the size was read in
    // logical ones, so the pointer is scaled down to match rather than the
    // window being compared in two units at once.
    const [size, pointer, monitor, scale] = await Promise.all([
      win.innerSize(),
      cursorPosition(),
      currentMonitor(),
      win.scaleFactor(),
    ]);
    const logicalPointer = {
      x: pointer.x / (scale || 1),
      y: pointer.y / (scale || 1),
    };
    return restoredPosition(
      grab,
      size,
      logicalPointer,
      monitor?.workArea.position ?? { x: 0, y: 0 },
    );
  } catch {
    return null;
  }
};

const startWindowDrag = (win: TauriWindow) =>
  win.startDragging().catch(showErrorSnackbar);

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
const restoreAndDrag = async (win: TauriWindow, press: DragPoint) => {
  try {
    const grab = await readGrab(win, press);
    if (grab === null) {
      startWindowDrag(win);
      return;
    }
    await win.unmaximize();
    const target = await readRestoreTarget(win, grab);
    if (target !== null) {
      await win.setPosition(new LogicalPosition(target.x, target.y));
    }
    await startWindowDrag(win);
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
  /** Set once the gesture has committed to restoring, so it happens once. */
  restored: boolean;
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
    if (gesture.maximized && !gesture.restored) {
      gesture.restored = true;
      restoreAndDrag(gesture.win, gesture.origin).catch(showErrorSnackbar);
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
  maximizedRef: React.MutableRefObject<boolean>,
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
        maximized: maximizedRef.current,
        restored: false,
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
