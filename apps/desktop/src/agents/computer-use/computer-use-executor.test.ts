import type {
  CapturedFrame,
  DisplayGeometry,
  PhysicalRect,
} from "@maus-inc/desktop-native-apis";
import type { ComputerUseAction } from "@maus-inc/types";
import { describe, expect, it, vi } from "vitest";
import {
  executeComputerUseAction,
  toDisplayPoint,
  toPhysicalRect,
  transformFor,
  type ComputerUseHost,
} from "./computer-use-executor";

const DISPLAY: DisplayGeometry = {
  id: 1,
  originX: 0,
  originY: 0,
  widthPx: 1920,
  heightPx: 1080,
  scaleFactor: 1,
};

const frame = (over: Partial<CapturedFrame> = {}): CapturedFrame => ({
  data: "AAAA",
  mimeType: "image/png",
  imageWidth: 1280,
  imageHeight: 720,
  sourceWidth: 1920,
  sourceHeight: 1080,
  displayId: 1,
  ...over,
});

type Calls = {
  [K in keyof ComputerUseHost]?: ComputerUseHost[K];
};

/** A host that records what it was asked to do and does nothing else. */
const hostWith = (calls: Calls = {}): ComputerUseHost => ({
  listDisplays: vi.fn(async () => [DISPLAY]),
  captureScreen: vi.fn(async () => frame()),
  captureScreenRegion: vi.fn(async () =>
    frame({ imageWidth: 100, imageHeight: 50 }),
  ),
  computerUsePointerPosition: vi.fn(async (): Promise<[number, number]> => [
    10, 20,
  ]),
  computerUseMove: vi.fn(async () => undefined),
  computerUseClick: vi.fn(async () => undefined),
  computerUsePressButton: vi.fn(async () => undefined),
  computerUseReleaseButton: vi.fn(async () => undefined),
  computerUseDrag: vi.fn(async () => undefined),
  computerUseScroll: vi.fn(async () => undefined),
  computerUsePressKey: vi.fn(async () => undefined),
  computerUsePressKeyDown: vi.fn(async () => undefined),
  computerUseReleaseKeyUp: vi.fn(async () => undefined),
  computerUseType: vi.fn(async () => undefined),
  computerUseWait: vi.fn(async () => undefined),
  computerUseCancel: vi.fn(async () => undefined),
  computerUseResetCancel: vi.fn(async () => undefined),
  ...calls,
});

const run = (
  host: ComputerUseHost,
  action: ComputerUseAction,
  approved = true,
  transform = transformFor(frame(), [DISPLAY]),
) =>
  executeComputerUseAction({
    host,
    transform,
    callId: "c1",
    providerName: "test-provider",
    action,
    approved,
  });

describe("transformFor", () => {
  it("finds the display the capture came from", () => {
    const display = { ...DISPLAY, id: 7, originX: -1280, originY: 0 };
    expect(
      transformFor(frame({ displayId: 7 }), [DISPLAY, display]).display,
    ).toBe(display);
  });

  it("reports a capture from a display that has been unplugged", () => {
    expect(() => transformFor(frame({ displayId: 9 }), [DISPLAY])).toThrow(
      /display 9/,
    );
  });
});

describe("toDisplayPoint", () => {
  const transform = transformFor(frame(), [DISPLAY]);

  it("leaves a display pixel alone rather than scaling it a second time", () => {
    // The adapters already turn the wire dialect into display pixels: the
    // Gemini grid and an Anthropic screenshot pixel both land here. Scaling
    // again put every click at a multiple of the capture ratio, and that
    // multiple is exactly 1 on a 1280-wide display, so nothing reports it.
    expect(toDisplayPoint(transform, 960, 540)).toEqual({ x: 960, y: 540 });
    expect(toDisplayPoint(transform, 1, 1)).toEqual({ x: 1, y: 1 });
  });

  it("keeps the right edge on the last pixel rather than one past it", () => {
    expect(toDisplayPoint(transform, 1920, 1080)).toEqual({ x: 1919, y: 1079 });
  });

  it("clamps a coordinate past the corner instead of trusting it", () => {
    expect(toDisplayPoint(transform, 99999, -40)).toEqual({ x: 1919, y: 0 });
  });

  it("maps every point onto the same display when the capture was not resized", () => {
    const unscaled = transformFor(
      frame({ imageWidth: 1920, imageHeight: 1080 }),
      [DISPLAY],
    );
    expect(toDisplayPoint(unscaled, 100, 200)).toEqual({ x: 100, y: 200 });
  });
});

describe("toPhysicalRect", () => {
  it("turns two corners into an origin and a size", () => {
    expect(toPhysicalRect({ x0: 10, y0: 20, x1: 110, y1: 220 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("sorts reversed corners rather than reporting an empty region", () => {
    const rect: PhysicalRect = toPhysicalRect({
      x0: 110,
      y0: 220,
      x1: 10,
      y1: 20,
    });
    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });
});

describe("executeComputerUseAction", () => {
  it("clicks the display pixel the action names", async () => {
    const host = hostWith();
    const result = await run(host, { type: "click", x: 640, y: 360 });
    expect(host.computerUseClick).toHaveBeenCalledWith(
      1,
      640,
      360,
      "left",
      1,
      null,
    );
    expect(result.success).toBe(true);
  });

  it("passes the click count, the button and the modifiers through", async () => {
    const host = hostWith();
    await run(host, {
      type: "click",
      x: 10,
      y: 20,
      button: "right",
      clicks: 3,
      modifiers: ["ctrl"],
    });
    expect(host.computerUseClick).toHaveBeenCalledWith(1, 10, 20, "right", 3, [
      "ctrl",
    ]);
  });

  it("does not click when the user said no, and says why", async () => {
    const host = hostWith();
    const result = await run(host, { type: "click", x: 10, y: 20 }, false);
    expect(host.computerUseClick).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.message).toMatch(/did not approve/i);
  });

  it("distinguishes a refusal from a failure so the model can tell them apart", async () => {
    const host = hostWith({
      computerUseClick: vi.fn(async () => {
        throw new Error("the window vanished");
      }),
    });
    const refused = await run(host, { type: "click", x: 1, y: 1 }, false);
    const broken = await run(host, { type: "click", x: 1, y: 1 }, true);
    expect(refused.skipped).toBe(true);
    expect(broken.skipped).toBeUndefined();
    expect(broken.message).toMatch(/could not be completed/);
  });

  it("presses and releases at the pointer rather than at a named point", async () => {
    const host = hostWith();
    await run(host, { type: "mouse_down" });
    await run(host, { type: "mouse_up", button: "right" });
    expect(host.computerUsePressButton).toHaveBeenCalledWith("left");
    expect(host.computerUseReleaseButton).toHaveBeenCalledWith("right");
  });

  it("moves to the named point before pressing, in that argument order", async () => {
    // Every parameter of `computerUseMove` is a number, so transposing the
    // display id with a coordinate type-checks and silently presses on the
    // wrong screen. This is the only assertion that pins the order.
    const host = hostWith();
    await run(host, { type: "mouse_down", x: 640, y: 360 });
    expect(host.computerUseMove).toHaveBeenCalledWith(1, 640, 360);

    const release = hostWith();
    await run(release, { type: "mouse_up", x: 100, y: 200 });
    expect(release.computerUseMove).toHaveBeenCalledWith(1, 100, 200);
  });

  it("does not move the pointer for a press that names no point", async () => {
    const host = hostWith();
    await run(host, { type: "mouse_down" });
    expect(host.computerUseMove).not.toHaveBeenCalled();
  });

  it("drags between both endpoints", async () => {
    const host = hostWith();
    await run(host, { type: "drag", fromX: 0, fromY: 0, toX: 640, toY: 360 });
    expect(host.computerUseDrag).toHaveBeenCalledWith(
      1,
      0,
      0,
      640,
      360,
      "left",
      null,
    );
  });

  it("sends a chord as one string with repeat and hold only when asked", async () => {
    const host = hostWith();
    await run(host, { type: "key", keys: ["ctrl", "c"] });
    expect(host.computerUsePressKey).toHaveBeenLastCalledWith(
      "ctrl+c",
      null,
      null,
    );
    await run(host, { type: "key", keys: ["tab"], repeat: 3 });
    expect(host.computerUsePressKey).toHaveBeenLastCalledWith("tab", 3, null);
  });

  it("separates pressing a key down from releasing it", async () => {
    const host = hostWith();
    await run(host, { type: "key_down", keys: ["shift"] });
    await run(host, { type: "key_up", keys: ["shift"] });
    expect(host.computerUsePressKeyDown).toHaveBeenCalledWith("shift");
    expect(host.computerUseReleaseKeyUp).toHaveBeenCalledWith("shift");
  });

  it("types without pressing enter unless the action says so", async () => {
    const host = hostWith();
    await run(host, { type: "type", text: "hello" });
    expect(host.computerUseType).toHaveBeenLastCalledWith("hello", false);
    await run(host, { type: "type", text: "hello", pressEnter: true });
    expect(host.computerUseType).toHaveBeenLastCalledWith("hello", true);
  });

  it("leaves the pointer where it is when scrolling", async () => {
    const host = hostWith();
    await run(host, { type: "scroll", direction: "down", amount: 300 });
    expect(host.computerUseScroll).toHaveBeenCalledWith(
      "down",
      300,
      1,
      null,
      null,
    );
  });

  it("does not capture the screen again, because the model already has it", async () => {
    const host = hostWith();
    await run(host, { type: "screenshot" });
    expect(host.captureScreen).not.toHaveBeenCalled();
  });

  it("hands the native zoom the encoded frame and the region in image pixels", async () => {
    const host = hostWith();
    const previous = frame({ data: "Zm9v" });
    await executeComputerUseAction({
      host,
      transform: transformFor(previous, [DISPLAY]),
      callId: "c1",
      providerName: "test-provider",
      action: { type: "zoom", region: { x0: 100, y0: 50, x1: 300, y1: 250 } },
      approved: true,
    });
    expect(host.captureScreenRegion).toHaveBeenCalledWith(previous, {
      x: 100,
      y: 50,
      width: 200,
      height: 200,
    });
  });

  it("says so when the system cannot report the pointer, instead of reading the origin", async () => {
    const host = hostWith({
      computerUsePointerPosition: vi.fn(async () => null),
    });
    const result = await run(host, { type: "cursor_position" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/cannot report where the pointer is/);
  });

  it("tells the model not to retry an action its provider cannot do", async () => {
    const host = hostWith();
    const result = await run(host, {
      type: "unsupported",
      providerName: "test-provider",
      reason: "This provider cannot scroll a desktop.",
    });
    expect(host.computerUseScroll).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/do not try it again/i);
  });

  it("returns a failure rather than throwing when the native call rejects", async () => {
    const host = hostWith({
      computerUseMove: vi.fn(async () => {
        throw new Error("no such display");
      }),
    });
    const result = await run(host, { type: "move", x: 5, y: 5 });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no such display/);
  });
});
