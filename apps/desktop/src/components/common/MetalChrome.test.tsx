// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

/*
 * Renders the REAL metal-fx (no module mock), so these tests exercise the
 * library's own hiding mechanism and its className/prop forwarding.
 *
 * jsdom has no WebGL or 2D canvas, so both contexts are stubbed with inert
 * proxies. requestAnimationFrame is captured so each test decides whether the
 * library's renderer ever produces a first frame:
 *   - never flushing frames models "the shader never paints";
 *   - flushing frames models the normal path.
 * jsdom has no layout, so hit-testing itself still needs a manual check.
 */

vi.mock("@mui/material", () => ({
  useColorScheme: () => ({ mode: "dark", systemMode: "dark" }),
  useTheme: () => ({ palette: { mode: "dark" } }),
}));
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("framer-motion", () => ({ useReducedMotion: () => motion.reduced }));

/** Proxy whose every property is a no-op function returning a truthy value. */
const inert = (): unknown =>
  new Proxy(function () {} as unknown as object, {
    get: (_t, prop) => {
      if (prop === "canvas") return document.createElement("canvas");
      if (prop === "then") return undefined;
      return (..._args: unknown[]) => inert();
    },
    apply: () => inert(),
  });

ensureUiHarness();

let frames: FrameRequestCallback[] = [];
// metal-fx keeps a module-level renderer whose frame throttle remembers the
// last timestamp, so the fake clock must keep increasing across tests.
let frameClock = performance.now();
const flushFrames = (count: number) => {
  for (let i = 0; i < count; i++) {
    const pending = frames;
    frames = [];
    frameClock += 1000; // far apart so the frame throttle never skips
    for (const cb of pending) cb(frameClock);
  }
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal(
    "Path2D",
    class {
      constructor() {
        return inert() as object;
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() =>
    inert()) as unknown as HTMLCanvasElement["getContext"]);
  const style = document.createElement("style");
  style.textContent = readFileSync(join(__dirname, "MetalChrome.css"), "utf8");
  document.head.appendChild(style);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.head.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPlayButton = async () => {
  const { MetalChrome } = await import("./MetalChrome");
  act(() =>
    root.render(
      <MetalChrome variant="circle" className="extra">
        <button type="button">Play</button>
      </MetalChrome>,
    ),
  );
  const wrapper = container.querySelector<HTMLElement>(".metal-fx-root");
  expect(wrapper, "metal-fx did not take its WebGL path").not.toBeNull();
  return wrapper!;
};

describe("MetalChrome over the real metal-fx", () => {
  it("forwards our class and marker onto the element metal-fx hides", async () => {
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_ATTR } = await import("./MetalChrome");
    // Library contract: the wrapper is hidden until a first frame is copied.
    expect(wrapper.style.visibility).toBe("hidden");
    // Forwarding contract: our props land on that same hidden node.
    expect(wrapper.hasAttribute(METAL_CHROME_ATTR)).toBe(true);
    expect(wrapper.classList).toContain("extra");
    expect(wrapper.querySelector("button")?.textContent).toBe("Play");
  });

  it("rescues the control only when the shader never paints", async () => {
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await import("./MetalChrome");

    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS - 1));
    expect(wrapper.classList).not.toContain(METAL_CHROME_RESCUED_CLASS);
    expect(getComputedStyle(wrapper).visibility).toBe("hidden");

    act(() => vi.advanceTimersByTime(1));
    expect(wrapper.classList).toContain(METAL_CHROME_RESCUED_CLASS);
    expect(getComputedStyle(wrapper).visibility).toBe("visible");
    expect(getComputedStyle(wrapper).opacity).toBe("1");
  });

  it("leaves the normal first-frame reveal entirely to metal-fx", async () => {
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await import("./MetalChrome");

    act(() => flushFrames(3));
    expect(wrapper.style.visibility).toBe("visible");

    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).not.toContain(METAL_CHROME_RESCUED_CLASS);
  });

  it("hands control back to metal-fx if the first frame arrives late", async () => {
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await import("./MetalChrome");

    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).toContain(METAL_CHROME_RESCUED_CLASS);

    await act(async () => {
      flushFrames(3);
      await Promise.resolve(); // let the MutationObserver deliver
    });
    expect(wrapper.style.visibility).toBe("visible");
    expect(wrapper.classList).not.toContain(METAL_CHROME_RESCUED_CLASS);
  });

  it("under reduced motion, leaves a successful reveal to metal-fx", async () => {
    // The rescue is state-based: whatever path metal-fx takes, if it reveals
    // the wrapper itself, the rescue never applies. Assert outcomes only.
    motion.reduced = true;
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await import("./MetalChrome");

    act(() => flushFrames(3));
    expect(wrapper.style.visibility).toBe("visible");

    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).not.toContain(METAL_CHROME_RESCUED_CLASS);
  });

  it("under reduced motion, still rescues a control that never paints", async () => {
    motion.reduced = true;
    const wrapper = await renderPlayButton();
    const { METAL_CHROME_RESCUE_DELAY_MS, METAL_CHROME_RESCUED_CLASS } =
      await import("./MetalChrome");

    // No frames are ever flushed: nothing is copied while paused either.
    act(() => vi.advanceTimersByTime(METAL_CHROME_RESCUE_DELAY_MS));
    expect(wrapper.classList).toContain(METAL_CHROME_RESCUED_CLASS);
    expect(getComputedStyle(wrapper).visibility).toBe("visible");
    expect(getComputedStyle(wrapper).opacity).toBe("1");
  });
});
