import { Box } from "@mui/material";
import {
  getCurrentWindow,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";
import { useCallback } from "react";
import { isTauriRuntime } from "../../utils/env.utils";

/**
 * `@tauri-apps/api` declares the direction union but does not re-export it, so
 * derive it from the method signature rather than hand-copying the literals.
 */
type ResizeDirection = Parameters<TauriWindow["startResizeDragging"]>[0];

/**
 * Edge grip thickness in px. Matches the hit area a native frame would expose,
 * which is intentionally thin so it never steals clicks from real content.
 */
const EDGE = 4;
/** Corner grips are square and larger so diagonal resize stays reachable. */
const CORNER = 12;

type Grip = {
  direction: ResizeDirection;
  cursor: string;
  position: Record<string, number>;
};

const GRIPS: readonly Grip[] = [
  {
    direction: "North",
    cursor: "ns-resize",
    position: { top: 0, left: CORNER, right: CORNER, height: EDGE },
  },
  {
    direction: "South",
    cursor: "ns-resize",
    position: { bottom: 0, left: CORNER, right: CORNER, height: EDGE },
  },
  {
    direction: "West",
    cursor: "ew-resize",
    position: { left: 0, top: CORNER, bottom: CORNER, width: EDGE },
  },
  {
    direction: "East",
    cursor: "ew-resize",
    position: { right: 0, top: CORNER, bottom: CORNER, width: EDGE },
  },
  {
    direction: "NorthWest",
    cursor: "nwse-resize",
    position: { top: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "NorthEast",
    cursor: "nesw-resize",
    position: { top: 0, right: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "SouthWest",
    cursor: "nesw-resize",
    position: { bottom: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "SouthEast",
    cursor: "nwse-resize",
    position: { bottom: 0, right: 0, width: CORNER, height: CORNER },
  },
];

/**
 * Invisible resize grips for the frameless window.
 *
 * `decorations: false` removes the OS frame, and with it the native resize
 * border, so the window can only be resized through explicitly hit-tested
 * regions. These sit above every other surface and hand the gesture straight
 * back to the window manager via `startResizeDragging`, which keeps the resize
 * running on the native side (no per-frame IPC, no cursor drift).
 */
export const WindowResizeHandles = () => {
  const startResize = useCallback(
    (direction: ResizeDirection) => (event: React.PointerEvent) => {
      // Primary button only: a right-click near an edge must still open menus.
      if (event.button !== 0) return;
      event.preventDefault();
      void getCurrentWindow()
        .startResizeDragging(direction)
        .catch(() => undefined);
    },
    [],
  );

  if (!isTauriRuntime()) return null;

  return (
    <>
      {GRIPS.map((grip) => (
        <Box
          key={grip.direction}
          role="presentation"
          onPointerDown={startResize(grip.direction)}
          sx={{
            position: "fixed",
            ...grip.position,
            cursor: grip.cursor,
            // Above the title bar (z 20) and any floating surface, but purely
            // a hit target — nothing is painted here.
            zIndex: 2000,
            backgroundColor: "transparent",
          }}
        />
      ))}
    </>
  );
};
