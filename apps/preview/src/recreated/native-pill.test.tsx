// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpecProvider } from "../lib/spec-store";
import { NativePillCanvas, type PillPhase } from "./native-pill";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("framer-motion", () => ({ useReducedMotion: () => motion.reduced }));

let container: HTMLDivElement;
let root: Root;
let frame: FrameRequestCallback;
let cancel: ReturnType<typeof vi.fn>;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  motion.reduced = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    scale: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({
      width: Array.from(text).length * 8,
    })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
  ctx = context as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 42;
    }),
  );
  cancel = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancel);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (phase: PillPhase, stageText?: string) => {
  act(() =>
    root.render(
      <SpecProvider>
        <NativePillCanvas phase={phase} stageText={stageText} />
      </SpecProvider>,
    ),
  );
  act(() => frame(0));
};

it("paints a recording waveform and cancels its frame on unmount", () => {
  render("recording");
  expect(ctx.lineTo).toHaveBeenCalled();
  expect(ctx.stroke).toHaveBeenCalledTimes(4);
  act(() => root.render(null));
  expect(cancel).toHaveBeenCalledWith(42);
});

it("paints a loading track and elides a long stage label", () => {
  render("loading", "A very long transcription stage label");
  expect(ctx.fillRect).toHaveBeenCalled();
  const drawn = vi.mocked(ctx.fillText).mock.calls[0][0];
  expect(drawn.endsWith("…")).toBe(true);
  expect(drawn.length).toBeLessThan(
    "A very long transcription stage label".length,
  );
});

it("paints a paused bar without drawing waveform lines", () => {
  render("paused");
  expect(ctx.fillRect).toHaveBeenCalled();
  expect(ctx.lineTo).not.toHaveBeenCalled();
});

it("paints the latest phase on the existing animation loop", () => {
  render("recording");
  vi.mocked(ctx.lineTo).mockClear();
  act(() =>
    root.render(
      <SpecProvider>
        <NativePillCanvas phase="loading" stageText="Working" />
      </SpecProvider>,
    ),
  );
  act(() => frame(0));
  expect(ctx.lineTo).not.toHaveBeenCalled();
  expect(ctx.fillText).toHaveBeenCalledWith(
    "Working",
    expect.any(Number),
    expect.any(Number),
  );
});

it("renders idle hover and centers the loading indicator with reduced motion", () => {
  motion.reduced = true;
  act(() =>
    root.render(
      <SpecProvider>
        <NativePillCanvas phase="idle" hovered />
      </SpecProvider>,
    ),
  );
  act(() => frame(0));
  expect(ctx.fillText).toHaveBeenCalledWith(
    "Click to dictate",
    expect.any(Number),
    expect.any(Number),
  );
  vi.mocked(ctx.fillText).mockClear();
  act(() =>
    root.render(
      <SpecProvider>
        <NativePillCanvas phase="loading" />
      </SpecProvider>,
    ),
  );
  act(() => frame(0));
  expect(ctx.fillText).not.toHaveBeenCalled();
  const fills = vi.mocked(ctx.fillRect).mock.calls;
  const track = fills[0],
    indicator = fills[1];
  expect(indicator[0]).toBeCloseTo(track[0] + (track[2] - indicator[2]) / 2);
});
