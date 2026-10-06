import type {
  CaptureRequest,
  CapturedFrame,
  DisplayGeometry,
  MouseButton,
  PhysicalRect,
  ScrollDirection,
} from "@maus-inc/desktop-native-apis";
import type {
  ComputerUseAction,
  ComputerUseActionResult,
  ComputerUseRegion,
} from "@maus-inc/types";
import { getLogger } from "../../utils/log.utils";

const log = getLogger();

/**
 * The native calls the loop makes, gathered behind one interface.
 *
 * Each member matches the generated binding exactly, so the test double and the
 * real thing cannot drift. Anything needing a different shape would have to be a
 * new binding, which is where a reviewer sees it.
 */
export type ComputerUseHost = {
  listDisplays: () => Promise<DisplayGeometry[]>;
  captureScreen: (request: CaptureRequest) => Promise<CapturedFrame>;
  captureScreenRegion: (
    previous: CapturedFrame,
    region: PhysicalRect,
  ) => Promise<CapturedFrame>;
  computerUsePointerPosition: () => Promise<[number, number] | null>;
  computerUseMove: (displayId: number, x: number, y: number) => Promise<void>;
  computerUseClick: (
    displayId: number,
    x: number,
    y: number,
    button: MouseButton,
    clicks: number,
    modifiers: string[] | null,
  ) => Promise<void>;
  computerUsePressButton: (button: MouseButton) => Promise<void>;
  computerUseReleaseButton: (button: MouseButton) => Promise<void>;
  computerUseDrag: (
    displayId: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: MouseButton,
    modifiers: string[] | null,
  ) => Promise<void>;
  computerUseScroll: (
    direction: ScrollDirection,
    amount: number,
    displayId: number | null,
    x: number | null,
    y: number | null,
  ) => Promise<void>;
  computerUsePressKey: (
    chord: string,
    repeat: number | null,
    holdMs: number | null,
  ) => Promise<void>;
  computerUsePressKeyDown: (chord: string) => Promise<void>;
  computerUseReleaseKeyUp: (chord: string) => Promise<void>;
  computerUseType: (text: string, pressEnter: boolean) => Promise<void>;
  computerUseWait: (durationMs: number) => Promise<void>;
  computerUseCancel: () => Promise<void>;
  computerUseResetCancel: () => Promise<void>;
};

/**
 * The screenshot the model is looking at right now, and the display it came from.
 *
 * `frame` is kept whole because the native zoom needs the encoded bytes back: the
 * renderer has no image decoder, so the crop cannot happen here. `imageWidth` is
 * the width of the IMAGE the model was shown, which is not the display width
 * whenever the capture was downscaled. Every coordinate the model names is an
 * image coordinate, and that is why both widths travel together.
 */
export type CaptureTransform = {
  frame: CapturedFrame;
  display: DisplayGeometry;
};

export const SCREENSHOT_MAX_WIDTH = 1280;

export const transformFor = (
  frame: CapturedFrame,
  displays: DisplayGeometry[],
): CaptureTransform => {
  const display = displays.find((d) => d.id === frame.displayId);
  if (!display) {
    throw new Error(
      `The screenshot came from display ${frame.displayId}, which is not connected any more.`,
    );
  }
  return { frame, display };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Turn a point stated against the image into a point on that display.
 *
 * The model may name the right edge or the bottom edge, and the screen's last
 * pixel is the correct answer there. Clamping to the source size itself would
 * put the click one pixel past the display, which on Windows lands on whatever
 * is beyond it.
 */
/**
 * Pins an action's point to the display and records the mapping.
 *
 * The vocabulary states every coordinate in physical display pixels, and each
 * adapter converts the wire dialect into that space itself: the Gemini grid
 * becomes display pixels and an Anthropic screenshot pixel becomes a display
 * pixel. That conversion happens exactly once, here only the point is
 * clamped. Rescaling it a second time puts every click at a multiple of the
 * capture ratio, and the multiple is exactly 1 on a 1280-wide display, so the
 * mistake survives a check at that resolution and nothing reports it.
 */
export const toDisplayPoint = (
  transform: CaptureTransform,
  x: number,
  y: number,
): { x: number; y: number } => {
  const { sourceWidth, sourceHeight, imageWidth, imageHeight } =
    transform.frame;
  const point = {
    x: clamp(Math.round(x), 0, Math.max(sourceWidth - 1, 0)),
    y: clamp(Math.round(y), 0, Math.max(sourceHeight - 1, 0)),
  };
  log.verbose(
    `Computer use coordinate: display ${point.x},${point.y} on a ` +
      `${sourceWidth}x${sourceHeight} display captured at ${imageWidth}x${imageHeight}`,
  );
  return point;
};

/**
 * Turn a zoom region stated as two corners into the origin-and-size the native
 * call takes.
 *
 * The native side rescales the region onto the display itself, so this stays in
 * image pixels. Corners are sorted rather than assumed ordered, because a model
 * that names the bottom-left corner first should get the same region, not an
 * empty one.
 */
/**
 * Expresses a display pixel back in the units the model was shown.
 *
 * Anthropic documents the answer to `cursor_position` as the position in
 * screenshot pixels, and the native layer reports physical display pixels. On
 * a capture narrower than the display the two differ, and the model computes
 * its next coordinate from whatever it is told, so it has to be answered in
 * the space it has been reasoning about.
 */
export const toCapturePoint = (
  transform: CaptureTransform,
  displayX: number,
  displayY: number,
): { x: number; y: number } => {
  const { imageWidth, imageHeight, sourceWidth, sourceHeight } =
    transform.frame;
  return {
    x: clamp(
      Math.round((displayX * imageWidth) / Math.max(sourceWidth, 1)),
      0,
      Math.max(imageWidth - 1, 0),
    ),
    y: clamp(
      Math.round((displayY * imageHeight) / Math.max(sourceHeight, 1)),
      0,
      Math.max(imageHeight - 1, 0),
    ),
  };
};

export const toPhysicalRect = (region: ComputerUseRegion): PhysicalRect => {
  const x = Math.min(region.x0, region.x1);
  const y = Math.min(region.y0, region.y1);
  return {
    x,
    y,
    width: Math.abs(region.x1 - region.x0),
    height: Math.abs(region.y1 - region.y0),
  };
};

const ok = (
  callId: string,
  providerName: string,
  message: string,
): ComputerUseActionResult => ({
  callId,
  providerName,
  success: true,
  message,
});

const failed = (
  callId: string,
  providerName: string,
  message: string,
): ComputerUseActionResult => ({
  callId,
  providerName,
  success: false,
  message,
});

/**
 * A refusal is not a failure.
 *
 * The model reads this text and steers from it, so "you declined that" has to
 * read differently from "that click did not work". Conflating the two teaches a
 * model to retry a refusal, which is the exact thing the user declined.
 */
const skipped = (
  callId: string,
  providerName: string,
  message: string,
): ComputerUseActionResult => ({
  callId,
  providerName,
  success: false,
  skipped: true,
  message,
});

/**
 * Modifier keys held for one action, or null when there are none.
 *
 * Null rather than an empty array because the binding takes `string[] | null`.
 */
const modifiersOf = (action: {
  modifiers?: readonly string[];
}): string[] | null => {
  const keys = action.modifiers ?? [];
  return keys.length > 0 ? [...keys] : null;
};

const DRAG_BUTTON: MouseButton = "left";

/**
 * Run one portable action against the OS.
 *
 * The type switch is exhaustive over `ComputerUseAction`, so a new member of the
 * union becomes a compile error here rather than a silent no-op when the model
 * reaches for it. No provider name appears in this file: the actions have
 * already been translated by whichever session produced them.
 */
export const executeComputerUseAction = async (args: {
  host: ComputerUseHost;
  transform: CaptureTransform;
  callId: string;
  providerName: string;
  action: ComputerUseAction;
  approved: boolean;
}): Promise<ComputerUseActionResult> => {
  const { host, transform, callId, providerName, action, approved } = args;
  try {
    switch (action.type) {
      case "screenshot": {
        return ok(
          callId,
          providerName,
          "The screen is unchanged since the last screenshot, so it was not captured again.",
        );
      }
      case "cursor_position": {
        const pointer = await host.computerUsePointerPosition();
        if (!pointer) {
          return failed(
            callId,
            providerName,
            "This system cannot report where the pointer is. Do not ask for it again.",
          );
        }
        const reported = toCapturePoint(transform, pointer[0], pointer[1]);
        return ok(
          callId,
          providerName,
          `The pointer is at x ${reported.x}, y ${reported.y}.`,
        );
      }
      case "zoom": {
        const frame = await host.captureScreenRegion(
          transform.frame,
          toPhysicalRect(action.region),
        );
        return ok(
          callId,
          providerName,
          `Captured the requested region. It is ${frame.imageWidth} by ${frame.imageHeight} pixels.`,
        );
      }
      case "move": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve moving the pointer.",
          );
        }
        const point = toDisplayPoint(transform, action.x, action.y);
        await host.computerUseMove(transform.display.id, point.x, point.y);
        return ok(
          callId,
          providerName,
          `Moved the pointer to ${point.x}, ${point.y}.`,
        );
      }
      case "click": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve this click.",
          );
        }
        const point = toDisplayPoint(transform, action.x, action.y);
        const clicks = action.clicks ?? 1;
        await host.computerUseClick(
          transform.display.id,
          point.x,
          point.y,
          action.button ?? "left",
          clicks,
          modifiersOf(action),
        );
        return ok(
          callId,
          providerName,
          `Clicked ${clicks} time${clicks > 1 ? "s" : ""} at ${point.x}, ${point.y} ` +
            `with the ${action.button ?? "left"} button.`,
        );
      }
      case "mouse_down":
      case "mouse_up": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve holding the mouse button.",
          );
        }
        // The pointer is moved first only when the provider named a point. Gemini
        // names one, and discarding it presses at a stale location, which
        // starts a drag somewhere the model never asked for. Anthropic leaves
        // the press wherever the pointer already is, and moving it there would
        // be a move the model did not ask for.
        const button = action.button ?? "left";
        if (action.x !== undefined && action.y !== undefined) {
          const point = toDisplayPoint(transform, action.x, action.y);
          await host.computerUseMove(transform.display.id, point.x, point.y);
        }
        if (action.type === "mouse_down") {
          await host.computerUsePressButton(button);
        } else {
          await host.computerUseReleaseButton(button);
        }
        return ok(
          callId,
          providerName,
          `${action.type === "mouse_down" ? "Pressed" : "Released"} the ${button} button.`,
        );
      }
      case "drag": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve this drag.",
          );
        }
        const from = toDisplayPoint(transform, action.fromX, action.fromY);
        const to = toDisplayPoint(transform, action.toX, action.toY);
        await host.computerUseDrag(
          transform.display.id,
          from.x,
          from.y,
          to.x,
          to.y,
          DRAG_BUTTON,
          modifiersOf(action),
        );
        return ok(
          callId,
          providerName,
          `Dragged from ${from.x}, ${from.y} to ${to.x}, ${to.y}.`,
        );
      }
      case "key_down":
      case "key_up": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve this key press.",
          );
        }
        const chord = action.keys.join("+");
        if (action.type === "key_down") {
          await host.computerUsePressKeyDown(chord);
        } else {
          await host.computerUseReleaseKeyUp(chord);
        }
        return ok(
          callId,
          providerName,
          `${action.type === "key_down" ? "Pressed" : "Released"} ${chord}.`,
        );
      }
      case "key": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve this key press.",
          );
        }
        await host.computerUsePressKey(
          action.keys.join("+"),
          action.repeat ?? null,
          action.holdMs ?? null,
        );
        return ok(callId, providerName, `Pressed ${action.keys.join("+")}.`);
      }
      case "type": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve typing this text.",
          );
        }
        await host.computerUseType(action.text, action.pressEnter ?? false);
        return ok(
          callId,
          providerName,
          `Typed ${action.text.length} characters.`,
        );
      }
      case "scroll": {
        if (!approved) {
          return skipped(
            callId,
            providerName,
            "You did not approve scrolling.",
          );
        }
        // A portable scroll names no point. The native call leaves the pointer
        // where it is, which scrolls whatever is under it, and that is the
        // surface the model believes it is looking at.
        await host.computerUseScroll(
          action.direction,
          action.amount,
          transform.display.id,
          null,
          null,
        );
        return ok(
          callId,
          providerName,
          `Scrolled ${action.direction} by ${action.amount} pixels.`,
        );
      }
      case "wait": {
        await host.computerUseWait(action.ms);
        return ok(callId, providerName, `Waited ${action.ms} milliseconds.`);
      }
      case "unsupported": {
        return failed(
          callId,
          providerName,
          `${action.reason} Do not try it again; take a different approach.`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Computer use action ${action.type} failed: ${message}`);
    return failed(
      callId,
      providerName,
      `The ${action.type.replace(/_/g, " ")} could not be completed: ${message}`,
    );
  }
};
