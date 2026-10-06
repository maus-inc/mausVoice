/**
 * The one test that crosses the adapter-to-executor boundary.
 *
 * Both halves of the coordinate path used to look correct on their own and
 * disagree with each other: each adapter converts the wire dialect into
 * physical display pixels, and the executor then converted a second time. On a
 * 1920-wide display with a 1280-wide capture that put every click at 1.5x its
 * intended place, and the factor is exactly 1 on a 1280-wide display, so a
 * test at that resolution and a manual check at that resolution both pass.
 *
 * Each half is therefore tested against the other here, with a real adapter
 * response and a real executor, rather than against a fixture that both halves
 * happen to agree with.
 */
import { describe, expect, it, vi } from "vitest";

import { createGeminiComputerUseSession } from "@maus-inc/voice-ai";

import type { CapturedFrame } from "@maus-inc/desktop-native-apis";

import { executeComputerUseAction } from "./computer-use-executor";
import type { ComputerUseHost } from "./computer-use-executor";
import type { CaptureTransform } from "./computer-use-executor";

/** A 2560x1440 display, captured at 1280x720, which is what the loop asks for. */
const DISPLAY_WIDTH = 2560;
const DISPLAY_HEIGHT = 1440;
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const DISPLAY_ID = 7;

const transform: CaptureTransform = {
  frame: {
    data: "AAAA",
    mimeType: "image/png",
    imageWidth: CAPTURE_WIDTH,
    imageHeight: CAPTURE_HEIGHT,
    sourceWidth: DISPLAY_WIDTH,
    sourceHeight: DISPLAY_HEIGHT,
    displayId: DISPLAY_ID,
  } as CapturedFrame,
  display: {
    id: DISPLAY_ID,
    originX: 0,
    originY: 0,
    widthPx: DISPLAY_WIDTH,
    heightPx: DISPLAY_HEIGHT,
    scaleFactor: 2,
  },
};

/** Every member of the host, so a renamed method cannot silently no-op. */
const host = (): ComputerUseHost => {
  const empty = async (): Promise<void> => undefined;
  return {
    listDisplays: vi.fn(async () => []),
    captureScreen: vi.fn(async () => transform.frame),
    captureScreenRegion: vi.fn(async () => transform.frame),
    computerUsePointerPosition: vi.fn(
      async (): Promise<[number, number] | null> => [0, 0],
    ),
    computerUseMove: vi.fn(empty),
    computerUseClick: vi.fn(empty),
    computerUsePressButton: vi.fn(empty),
    computerUseReleaseButton: vi.fn(empty),
    computerUseDrag: vi.fn(empty),
    computerUseScroll: vi.fn(empty),
    computerUsePressKey: vi.fn(empty),
    computerUsePressKeyDown: vi.fn(empty),
    computerUseReleaseKeyUp: vi.fn(empty),
    computerUseType: vi.fn(empty),
    computerUseWait: vi.fn(empty),
    computerUseCancel: vi.fn(empty),
    computerUseResetCancel: vi.fn(empty),
  };
};

/** The model aims at the centre of what it was shown, which is grid 500,500. */
const clickAtTheCentre = async (): Promise<{ x: number; y: number }> => {
  const fetchMock = vi.fn(async () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "interaction-1",
          steps: [
            {
              type: "function_call",
              id: "call-1",
              name: "click",
              arguments: { x: 500, y: 500 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  const session = createGeminiComputerUseSession({
    apiKey: "test-key",
    model: "test-model",
    environment: "desktop",
    customFetch: fetchMock as unknown as typeof fetch,
  });
  const turn = await session.start({
    systemPrompt: "test",
    goal: "click the centre",
    screenshot: {
      data: "AAAA",
      mimeType: "image/png",
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
    },
    displayWidth: DISPLAY_WIDTH,
    displayHeight: DISPLAY_HEIGHT,
  });
  const action = turn.actions[0]?.action;
  if (action?.type !== "click") {
    throw new Error(`Expected a click, got ${action?.type ?? "nothing"}`);
  }
  return { x: action.x, y: action.y };
};

describe("a coordinate survives the adapter and the executor unchanged", () => {
  it("lands the click on the display pixel the model's centre maps to, once", async () => {
    const adapterPoint = await clickAtTheCentre();

    // Half 500 of a 1000 grid on a 2560-wide display is 1280. Not 2560, which
    // is what a second scaling by the capture ratio would have produced.
    expect(adapterPoint).toEqual({ x: 1280, y: 720 });

    const hostDouble = host();
    const result = await executeComputerUseAction({
      host: hostDouble,
      transform,
      callId: "call-1",
      providerName: "gemini",
      action: { type: "click", x: adapterPoint.x, y: adapterPoint.y },
      approved: true,
    });

    expect(result.success).toBe(true);
    expect(hostDouble.computerUseClick).toHaveBeenCalledWith(
      DISPLAY_ID,
      1280,
      720,
      "left",
      1,
      null,
    );
  });

  it("reports the pointer in the units the model was shown", async () => {
    const hostDouble = host();
    hostDouble.computerUsePointerPosition = vi.fn(
      async (): Promise<[number, number] | null> => [1920, 1080],
    );

    const result = await executeComputerUseAction({
      host: hostDouble,
      transform,
      callId: "call-2",
      providerName: "gemini",
      action: { type: "cursor_position" },
      approved: true,
    });

    // The pointer is at 1920 of 2560 display pixels. The model reasons in the
    // 1280-wide capture it was shown, so it has to be told 960.
    expect(result.success).toBe(true);
    expect(result.message).toContain("960");
    expect(result.message).toContain("540");
    expect(result.message).not.toContain("1920");
  });
});
