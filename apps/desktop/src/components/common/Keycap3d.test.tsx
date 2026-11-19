// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
const { workerRequest, workerRelease } = vi.hoisted(() => ({
  workerRequest: vi.fn<() => Promise<ImageData> | null>(() => null),
  workerRelease: vi.fn(),
}));
vi.mock("./keycap3d.worker-client", () => ({
  requestCapRaster: workerRequest,
  releaseCapRaster: workerRelease,
}));
import { keycapGrain } from "../../styles/keycap";
import { Keycap3d, keycapLabelFontSize } from "./Keycap3d";
import {
  ANGLE_VIEW,
  FRONT_VIEW,
  createPixelRayFactory,
  createKeycapIntersector,
  createKeycapNormalSampler,
  compactIntersectionPlanes,
  dot,
  KEYCAP_RATIOS,
  intersectKeycap,
  keycapNormal,
  keycapPlanes,
  layoutKeycap,
  normalize,
  outline,
  plasticAt,
  rayForPixel,
  shadeKeycap,
  toCameraSpace,
  fromCameraSpace,
  type Vec3,
} from "./keycap3d.geometry";

ensureUiHarness();
const theme = createTheme({ cssVariables: true });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  workerRequest.mockReset();
  workerRelease.mockReset();
  workerRequest.mockReturnValue(null);
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (ui: React.ReactNode) =>
  act(() => {
    root.render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
  });

const waitForPaint = async (paint: ReturnType<typeof vi.fn>, count: number) => {
  await act(async () => {
    await vi.waitFor(() => expect(paint).toHaveBeenCalledTimes(count), {
      timeout: 10000,
    });
  });
};

const flushAction = async (action: () => void) => {
  await act(async () => {
    action();
    await Promise.resolve();
  });
};

const parts = (name: string) =>
  Array.from(container.querySelectorAll(`[data-keycap-part="${name}"]`));

const styleOf = (element: Element): CSSStyleDeclaration =>
  window.getComputedStyle(element);

const box = () => container.querySelector("[data-keycap-view]") as Element;

class TestImageData {
  static constructed = 0;
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    TestImageData.constructed += 1;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const mockCanvas = () => {
  const paint = vi.fn();
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  context.mockReturnValue({
    putImageData: paint,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("ImageData", TestImageData);
  return {
    paint,
    restore: () => {
      context.mockRestore();
      vi.unstubAllGlobals();
    },
  };
};

const ratios = {
  height: KEYCAP_RATIOS.height,
  face: KEYCAP_RATIOS.face,
  radius: KEYCAP_RATIOS.radius,
  faceTilt: KEYCAP_RATIOS.faceTilt,
  dish: KEYCAP_RATIOS.dish,
};

const referenceNormal = (
  point: Vec3,
  planes: ReturnType<typeof keycapPlanes>,
  roll: number,
): Vec3 => {
  const sum: [number, number, number] = [0, 0, 0];
  for (const plane of planes) {
    const inside = plane.offset - dot(plane.normal, point);
    if (inside < -roll) continue;
    const weight = Math.exp(-Math.max(inside, 0) / roll);
    for (let i = 0; i < 3; i += 1) sum[i] += plane.normal[i] * weight;
  }
  return normalize(sum);
};

describe("Keycap3d", () => {
  it("uses font metrics for the bundled Geist Pixel file", () => {
    const font = readFileSync(
      "src/assets/fonts/geist-pixel/GeistPixel-Square.woff2",
    );
    expect(createHash("sha256").update(font).digest("hex")).toBe(
      "80887afede26bc861e92dbfbb17a775d769e46e7c84f336b1c9f17959f60606d",
    );
  });

  it("includes the Geist Pixel license in desktop bundle resources", () => {
    const source = readFileSync(
      "../../packages/shared-fonts/geist-pixel/OFL-1.1.txt",
      "utf8",
    );
    const bundled = readFileSync(
      "src-tauri/resources/geist-pixel-OFL-1.1.txt",
      "utf8",
    );
    const config = JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    );
    expect(bundled).toBe(source);
    expect(config.bundle.resources).toContain("resources/*");
  });

  it("renders a canvas and keeps the label in the DOM", () => {
    render(<Keycap3d label="Shift" view="angle" size={200} />);
    expect(parts("cap")).toHaveLength(1);
    expect(parts("cap")[0].tagName).toBe("CANVAS");
    expect(container.querySelector("svg")).toBe(null);
    // The legend is DOM text rather than part of the canvas.
    expect(parts("label")).toHaveLength(1);
    expect(parts("label")[0].textContent).toBe("Shift");
  });

  it("shows a readable fallback when canvas is unavailable", () => {
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null);
    try {
      render(<Keycap3d label="K" view="angle" size={96} />);
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
      expect(styleOf(parts("label")[0]).transform).toBe(
        "translate(-50%, -50%)",
      );
      expect(box().getAttribute("data-keycap-fallback")).toBe("true");
    } finally {
      context.mockRestore();
    }
  });

  it("shows the fallback if requesting a canvas context throws", () => {
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => {
        throw new Error("context unavailable");
      });
    try {
      render(<Keycap3d label="K" size={34} />);
      expect(box().getAttribute("data-keycap-fallback")).toBe("true");
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
    } finally {
      context.mockRestore();
    }
  });

  it("shows the fallback when local raster creation fails", async () => {
    const { restore } = mockCanvas();
    vi.stubGlobal(
      "ImageData",
      vi.fn(function () {
        throw new Error("allocation failed");
      }),
    );
    try {
      render(<Keycap3d label="K" size={37.125} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(box().getAttribute("data-keycap-fallback")).toBe("true");
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
    } finally {
      restore();
    }
  });

  it("shows the fallback when painting fails", async () => {
    const { paint, restore } = mockCanvas();
    paint.mockImplementation(() => {
      throw new Error("context lost");
    });
    workerRequest.mockResolvedValueOnce(new TestImageData(1, 1) as ImageData);
    try {
      await flushAction(() => {
        root.render(
          <ThemeProvider theme={theme}>
            <Keycap3d label="K" size={34} />
          </ThemeProvider>,
        );
      });
      expect(box().getAttribute("data-keycap-fallback")).toBe("true");
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
    } finally {
      restore();
    }
  });

  it("ignores stale worker images after a shape change", async () => {
    const { paint, restore } = mockCanvas();
    let finishFirst!: (image: ImageData) => void;
    let finishSecond!: (image: ImageData) => void;
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSecond = resolve;
      }),
    );
    try {
      render(<Keycap3d label="A" size={34} />);
      // A slow or stalled worker must not leave the shortcut unreadable.
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
      expect(styleOf(parts("label")[0]).transform).toBe(
        "translate(-50%, -50%)",
      );
      render(<Keycap3d label="A" size={35} />);
      await flushAction(() => finishFirst(new ImageData(1, 1)));
      expect(paint).not.toHaveBeenCalled();
      await flushAction(() => finishSecond(new ImageData(2, 2)));
      expect(paint).toHaveBeenCalledTimes(1);
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
    } finally {
      restore();
    }
  });

  it("shows the fallback after context loss and repaints on restoration", async () => {
    const { paint, restore } = mockCanvas();
    let finish!: (image: ImageData) => void;
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    workerRequest.mockReturnValueOnce(
      Promise.resolve(new TestImageData(1, 1) as ImageData),
    );
    try {
      render(<Keycap3d label="K" size={34} />);
      const canvas = parts("cap")[0];
      const loss = new Event("contextlost", { cancelable: true });
      act(() => {
        canvas.dispatchEvent(loss);
      });
      expect(loss.defaultPrevented).toBe(false);
      expect(box().getAttribute("data-keycap-fallback")).toBe("true");
      await flushAction(() => finish(new TestImageData(1, 1) as ImageData));
      expect(paint).not.toHaveBeenCalled();
      await flushAction(() => {
        canvas.dispatchEvent(new Event("contextrestored"));
      });
      expect(paint).toHaveBeenCalledTimes(1);
      expect(box().getAttribute("data-keycap-fallback")).toBeNull();
    } finally {
      restore();
    }
  });

  it("releases worker requests when the shape changes or the cap unmounts", () => {
    const { restore } = mockCanvas();
    const first = new Promise<ImageData>(vi.fn());
    const second = new Promise<ImageData>(vi.fn());
    workerRequest.mockReturnValueOnce(first).mockReturnValueOnce(second);
    try {
      render(<Keycap3d label="A" size={34} />);
      render(<Keycap3d label="A" size={35} />);
      expect(workerRelease).toHaveBeenCalledWith(first);
      render(null);
      expect(workerRelease).toHaveBeenCalledWith(second);
      expect(workerRelease).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("ignores an older worker result after a DPR change", async () => {
    const { paint, restore } = mockCanvas();
    const original = Object.getOwnPropertyDescriptor(
      window,
      "devicePixelRatio",
    );
    const matchMedia = window.matchMedia.bind(window);
    let onChange: (() => void) | undefined;
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      if (!query.startsWith("(resolution:")) return matchMedia(query);
      return {
        addEventListener: (_event: string, callback: () => void) => {
          onChange = callback;
        },
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList;
    });
    let first!: (image: ImageData) => void;
    let second!: (image: ImageData) => void;
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        second = resolve;
      }),
    );
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    try {
      render(<Keycap3d label="A" size={34} />);
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: 2,
      });
      act(() => onChange?.());
      expect(workerRelease).toHaveBeenCalledWith(
        workerRequest.mock.results[0].value,
      );
      await flushAction(() => first(new ImageData(1, 1)));
      expect(paint).not.toHaveBeenCalled();
      await flushAction(() => second(new ImageData(2, 2)));
      expect(paint).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, "devicePixelRatio", original);
      media.mockRestore();
      restore();
    }
  });

  it("falls back to the local renderer if the worker fails", async () => {
    const { paint, restore } = mockCanvas();
    workerRequest.mockReturnValueOnce(
      Promise.reject(new Error("worker blocked")),
    );
    try {
      render(<Keycap3d label="A" size={34.25} />);
      await waitForPaint(paint, 1);
      expect(styleOf(parts("label")[0]).visibility).toBe("visible");
    } finally {
      restore();
    }
  });

  it("cancels an unfinished local raster on unmount", async () => {
    vi.useFakeTimers();
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d label="A" size={79.6} />);
      act(() => root.render(null));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(paint).not.toHaveBeenCalled();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("does not paint an unmounted cap when a worker reply arrives", async () => {
    const { paint, restore } = mockCanvas();
    let finish!: (image: ImageData) => void;
    workerRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    try {
      render(<Keycap3d label="A" size={34} />);
      act(() => root.render(null));
      await flushAction(() => finish(new ImageData(1, 1)));
      expect(paint).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("writes opaque cap pixels and transparent background pixels", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d view="front" size={34} />);
      await waitForPaint(paint, 1);
      expect(paint).toHaveBeenCalledTimes(1);
      const image = paint.mock.calls[0][0] as TestImageData;
      const alpha = image.data.filter((_, index) => index % 4 === 3);
      expect(alpha.some((value) => value === 255)).toBe(true);
      expect(alpha.some((value) => value === 0)).toBe(true);
      expect(alpha.some((value) => value > 0 && value < 255)).toBe(true);
    } finally {
      restore();
    }
  });

  it.each([1, 2])("paints a 34px front cap at DPR %s", async (dpr) => {
    const { paint, restore } = mockCanvas();
    const original = Object.getOwnPropertyDescriptor(
      window,
      "devicePixelRatio",
    );
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: dpr,
    });
    try {
      render(<Keycap3d view="front" size={34} />);
      await waitForPaint(paint, 1);
      const image = paint.mock.calls[0][0] as TestImageData;
      let min = image.width;
      let max = -1;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          if (image.data[(y * image.width + x) * 4 + 3] > 0) {
            min = Math.min(min, x);
            max = Math.max(max, x);
          }
        }
      }
      expect((max - min + 1) / dpr).toBe(34);
    } finally {
      if (original) Object.defineProperty(window, "devicePixelRatio", original);
      restore();
    }
  });

  it("repaints when the display pixel ratio changes", async () => {
    const { paint, restore } = mockCanvas();
    const original = Object.getOwnPropertyDescriptor(
      window,
      "devicePixelRatio",
    );
    const matchMedia = window.matchMedia.bind(window);
    let onChange: (() => void) | undefined;
    const remove = vi.fn();
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      if (!query.startsWith("(resolution:")) return matchMedia(query);
      return {
        addEventListener: (_event: string, callback: () => void) => {
          onChange = callback;
        },
        removeEventListener: remove,
      } as unknown as MediaQueryList;
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    try {
      render(<Keycap3d view="front" size={34} />);
      await waitForPaint(paint, 1);
      const first = paint.mock.calls[0][0] as TestImageData;
      expect(onChange).toBeDefined();
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: 2,
      });
      act(() => onChange?.());
      await waitForPaint(paint, 2);
      expect(paint).toHaveBeenCalledTimes(2);
      const second = paint.mock.calls[1][0] as TestImageData;
      expect(second.width).toBeGreaterThan(first.width);
      expect(remove).toHaveBeenCalledTimes(1);
      act(() => root.render(null));
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(window, "devicePixelRatio", original);
      media.mockRestore();
      restore();
    }
  });

  it("shares the raster between caps with identical geometry but different legends", async () => {
    const { paint, restore } = mockCanvas();
    const before = TestImageData.constructed;
    try {
      render(
        <>
          <Keycap3d size={37} grain={0.1379} label="A" />
          <Keycap3d size={37} grain={0.1379} label="B" />
        </>,
      );
      await waitForPaint(paint, 2);
      expect(TestImageData.constructed - before).toBe(1);
    } finally {
      restore();
    }
  });

  it("does not share cached rasters across different geometry or grain", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(
        <>
          <Keycap3d size={39.25} grain={0} />
          <Keycap3d size={39.25} grain={0.02} />
          <Keycap3d size={39.25} grain={0} ratios={{ face: 0.7 }} />
        </>,
      );
      await waitForPaint(paint, 3);
      const images = paint.mock.calls.map((call) => call[0]);
      expect(new Set(images).size).toBe(3);
    } finally {
      restore();
    }
  });

  it.each(["angle", "front"] as const)(
    "uses the shared grain material in the %s view",
    (view) => {
      const { restore } = mockCanvas();
      try {
        render(<Keycap3d size={34} view={view} />);
        expect(workerRequest).toHaveBeenCalledWith(
          expect.objectContaining({ grain: keycapGrain }),
        );
      } finally {
        restore();
      }
    },
  );

  it("adds subtle surface variation without changing the silhouette", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d size={96.125} view="angle" grain={0} />);
      await waitForPaint(paint, 1);
      render(<Keycap3d size={96.125} view="angle" grain={0.2} />);
      await waitForPaint(paint, 2);
      const plain = (paint.mock.calls[0][0] as TestImageData).data;
      const textured = (paint.mock.calls[1][0] as TestImageData).data;
      let changed = 0;
      let delta = 0;
      let opaque = 0;
      for (let i = 0; i < plain.length; i += 4) {
        expect(textured[i + 3]).toBe(plain[i + 3]);
        if (plain[i + 3] === 255) {
          opaque += 1;
          const difference = Math.abs(textured[i] - plain[i]);
          delta += difference;
          if (difference > 0) changed += 1;
        }
      }
      expect(changed).toBeGreaterThan(opaque * 0.05);
      expect(delta / opaque).toBeLessThan(2);
    } finally {
      restore();
    }
  });

  it("repaints and uses a separate raster when camera roll changes", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d view="angle" size={41} roll={0} />);
      await waitForPaint(paint, 1);
      render(<Keycap3d view="angle" size={41} roll={12} />);
      await waitForPaint(paint, 2);
      expect(paint.mock.calls[0][0]).not.toBe(paint.mock.calls[1][0]);
    } finally {
      restore();
    }
  });

  it("does not repaint when equivalent shape overrides receive a new object", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d view="front" size={34} ratios={{ height: 0.47 }} />);
      await waitForPaint(paint, 1);
      render(
        <Keycap3d view="front" size={34} ratios={{ height: 0.47 }} pressed />,
      );
      expect(paint).toHaveBeenCalledTimes(1);
      render(
        <Keycap3d view="front" size={34} ratios={{ height: 0.5 }} pressed />,
      );
      await waitForPaint(paint, 2);
    } finally {
      restore();
    }
  });

  it("sizes the box to the projected cap, not to the base edge", () => {
    render(<Keycap3d label="X" view="angle" size={200} />);
    const angle = layoutKeycap({ size: 200, view: "angle" });
    // Turned towards the camera, the cap presents its depth, so the box is
    // wider than the base edge the caller asked for.
    expect(angle.width).toBeGreaterThan(200);
    expect(Number.parseFloat(styleOf(box()).width)).toBeCloseTo(angle.width, 2);

    render(<Keycap3d label="X" view="front" size={200} />);
    const front = layoutKeycap({ size: 200, view: "front" });
    // The front camera is only a little raised, so the box is close to the
    // base edge but not equal to it.
    expect(front.width / 200).toBeGreaterThan(0.97);
    expect(front.width / 200).toBeLessThan(1.03);
    expect(Number.parseFloat(styleOf(box()).width)).toBeCloseTo(front.width, 2);
    expect(Number.parseFloat(styleOf(box()).height)).toBeCloseTo(
      front.height,
      2,
    );
  });

  it("scales the whole cap with size, so the dashboard cap reads at 34px", () => {
    const small = layoutKeycap({ size: 34, view: "front" });
    const large = layoutKeycap({ size: 68, view: "front" });
    // The box carries a pixel of raster bleed on each side, so measure the cap
    // itself. A 34px cap has to stay a 34px cap: the dashboard row is spaced
    // from that edge, and the design asks for the cap, not the canvas.
    const body = (width: number) => width - 2;
    expect(body(small.width) / 34).toBeCloseTo(1, 1);
    expect(body(large.width) / 68).toBeCloseTo(1, 1);
    expect(body(small.width) / 34).toBeCloseTo(body(large.width) / 68, 3);
    // Everything else is a ratio, so doubling the edge doubles the face.
    expect(large.faceSize).toBeCloseTo(small.faceSize * 2, 6);
  });

  it("renders no label when none is given", () => {
    render(<Keycap3d view="front" size={34} />);
    expect(parts("label")).toHaveLength(0);
  });

  it("stacks a side label above the glyph", () => {
    render(<Keycap3d label="Shift" sublabel="Left" view="front" size={84} />);
    const label = parts("label");
    expect(label).toHaveLength(1);
    expect(parts("sublabel")).toHaveLength(1);
    expect(parts("sublabel")[0].textContent).toBe("Left");
    expect(parts("glyph")).toHaveLength(1);
    expect(parts("glyph")[0].textContent).toBe("Shift");
    // The side word sits above the glyph, not beside it.
    const children = Array.from(label[0].children).map((node) => node.tagName);
    expect(children).toEqual(["SPAN", "SPAN"]);
  });

  it("sizes the stacked legend from the longest line", () => {
    render(<Keycap3d sublabel="Left" view="front" size={84} />);
    const label = parts("label")[0];
    // The face is what the round-over leaves.
    const face = 84 * (KEYCAP_RATIOS.face - 2 * KEYCAP_RATIOS.radius);
    expect(parseFloat(styleOf(label).fontSize)).toBeCloseTo(
      keycapLabelFontSize(face, "Left"),
      4,
    );
  });

  it("accounts for a longer sublabel when both lines are present", () => {
    render(
      <Keycap3d label="X" sublabel="Extraordinary" view="front" size={84} />,
    );
    const size = parseFloat(styleOf(parts("label")[0]).fontSize);
    const face = layoutKeycap({ size: 84, view: "front" }).faceSize;
    // The bundled font advances this word by 6.574em before letter spacing.
    expect(
      size * 0.62 * (6.574 + 0.04 * "Extraordinary".length),
    ).toBeLessThanOrEqual(face * 0.92 + 0.001);
  });

  it("applies the face projection to the DOM legend", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d label="X" view="angle" size={200} />);
      await waitForPaint(paint, 1);
      const layout = layoutKeycap({ size: 200, view: "angle" });
      const [a, b, c, d] = layout.faceMatrix;
      const [wx, wy] = layout.facePerspective;
      const projection = [a, b, 0, wx, c, d, 0, wy, 0, 0, 1, 0, 0, 0, 0, 1];
      expect(styleOf(parts("label")[0]).transform).toContain(
        `matrix3d(${projection.join(", ")})`,
      );
      expect(styleOf(parts("label")[0]).transformOrigin).toBe("0 0");
    } finally {
      restore();
    }
  });

  it("keeps the legend fixed to the cap while pressed", async () => {
    const { paint, restore } = mockCanvas();
    try {
      render(<Keycap3d label="X" view="angle" size={200} />);
      await waitForPaint(paint, 1);
      const restingTransform = styleOf(parts("label")[0]).transform;
      expect(restingTransform).toContain("matrix3d(");
      render(<Keycap3d label="X" view="angle" size={200} pressed />);
      expect(styleOf(parts("label")[0]).transform).toBe(restingTransform);
    } finally {
      restore();
    }
  });

  it("fits a wide Geist Pixel legend rather than assuming all letters have average width", () => {
    render(<Keycap3d label="WWW" view="front" size={84} />);
    const face = layoutKeycap({ size: 84, view: "front" }).faceSize;
    const size = parseFloat(styleOf(parts("label")[0]).fontSize);
    // The bundled font advances each W by 0.912em, plus 0.02em letter spacing.
    expect(size * (0.912 + 0.02) * 3).toBeLessThanOrEqual(face * 0.92 + 0.001);
  });

  it("keeps a long legend inside the face", () => {
    render(<Keycap3d label="Escape" view="front" size={84} />);
    const face = 84 * (KEYCAP_RATIOS.face - 2 * KEYCAP_RATIOS.radius);
    const size = parseFloat(styleOf(parts("label")[0]).fontSize);
    // The bundled font advances Escape by 3.306em before letter spacing.
    expect(size * (3.306 + 0.02 * "Escape".length)).toBeLessThanOrEqual(
      face * 0.92 + 0.001,
    );
  });

  it("sinks the cap when pressed, and drags the legend down with it", () => {
    render(<Keycap3d label="X" view="angle" size={200} />);
    expect(styleOf(box()).transform).toBe("none");

    render(<Keycap3d label="X" view="angle" size={200} pressed />);
    const travel = styleOf(box()).transform;
    expect(travel).toMatch(/translateY\(-?[\d.]+px\)/);
    // The travel equals the wall that collapses, so the cap does not float.
    const moved = Math.abs(Number.parseFloat(travel.replace(/[^-\d.]/g, "")));
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(200 * KEYCAP_RATIOS.height);
  });

  it("stamps the view on the box, so callers can target a camera", () => {
    render(<Keycap3d label="X" view="angle" size={120} />);
    expect(box().getAttribute("data-keycap-view")).toBe("angle");
    render(<Keycap3d label="X" view="front" size={120} />);
    expect(box().getAttribute("data-keycap-view")).toBe("front");
  });
});

describe("keycap geometry", () => {
  const planes = keycapPlanes(ratios);

  it("closes a cap with top, bottom and supporting wall planes", () => {
    expect(planes.length).toBeGreaterThan(2);
    expect(planes[0].normal[2]).toBeGreaterThan(0);
    expect(planes[1].normal[2]).toBeLessThan(0);
  });

  it("faces every plane outward, which the offset sign proves", () => {
    // The cap contains the origin, so an inward normal would give a negative
    // offset. This is the test that caught the pentagon.
    for (const plane of planes) {
      expect(plane.offset).toBeGreaterThan(0);
    }
    expect(Math.min(...planes.map((plane) => plane.offset))).toBeGreaterThan(
      0.1,
    );
  });

  it.each([
    ratios,
    { ...ratios, faceTilt: 0 },
    { ...ratios, height: 0.65, face: 0.72, radius: 0.09, faceTilt: 25 },
    { ...ratios, height: 0.16, face: 0.86, faceTilt: 30 },
  ])("keeps both outline rings inside and touching the walls", (requested) => {
    const shape = layoutKeycap({
      size: 100,
      view: "angle",
      ratios: requested,
    }).ratios;
    const walls = keycapPlanes(shape);
    const tip = (shape.faceTilt * Math.PI) / 180;
    const bottom: Vec3[] = outline(0.5, shape.radius).map(([x, y]) => [
      x,
      y,
      -shape.height / 2,
    ]);
    const top: Vec3[] = outline(shape.face / 2, shape.radius).map(([x, y]) => [
      x,
      y,
      shape.height / 2 - Math.tan(tip) * y,
    ]);
    for (const point of [...bottom, ...top]) {
      for (const plane of walls)
        expect(dot(plane.normal, point) - plane.offset).toBeLessThan(1e-8);
      const distanceToWall = Math.min(
        ...walls
          .slice(2)
          .map((plane) => Math.abs(dot(plane.normal, point) - plane.offset)),
      );
      expect(distanceToWall).toBeLessThan(1e-8);
    }
    expect(Math.abs((Math.tan(tip) * shape.face) / 2)).toBeLessThan(
      shape.height,
    );
  });

  it.each(
    [
      { ...ratios, faceTilt: 0 },
      ratios,
      { ...ratios, height: 0.16, faceTilt: 30 },
    ].flatMap((requested) =>
      (["angle", "front"] as const).map((view) => ({ requested, view })),
    ),
  )(
    "keeps the entire projected hull inside the raster bounds",
    ({ requested, view }) => {
      const layout = layoutKeycap({ size: 100, view, ratios: requested });
      const walls = keycapPlanes(layout.ratios);
      for (let y = -3; y <= layout.height + 3; y += 2) {
        for (const x of [-3, layout.width + 3]) {
          const ray = rayForPixel(
            x,
            y,
            layout.originX,
            layout.originY,
            100,
            layout.camera,
          );
          expect(intersectKeycap(ray.origin, ray.direction, walls)).toBeNull();
        }
      }
      for (let x = -3; x <= layout.width + 3; x += 2) {
        for (const y of [-3, layout.height + 3]) {
          const ray = rayForPixel(
            x,
            y,
            layout.originX,
            layout.originY,
            100,
            layout.camera,
          );
          expect(intersectKeycap(ray.origin, ray.direction, walls)).toBeNull();
        }
      }
    },
  );

  it("puts the top plane above the bottom plane, and both level", () => {
    const top = planes[0];
    const bottom = planes[1];
    expect(top.normal[2]).toBeGreaterThan(0.9);
    expect(bottom.normal[2]).toBeCloseTo(-1, 9);
    // The top plane is tipped, so its offset is not its height. Compare the
    // heights under the middle of the cap instead.
    const heightAt = (plane: (typeof planes)[number]) =>
      plane.offset / plane.normal[2];
    expect(heightAt(top)).toBeCloseTo(ratios.height / 2, 6);
    expect(heightAt(bottom)).toBeCloseTo(-ratios.height / 2, 6);
  });

  it.each([0, 16, 30])(
    "keeps the top normal at the dish centre with %i degrees of face tilt",
    (faceTilt) => {
      const shape = { ...ratios, faceTilt };
      const shapePlanes = keycapPlanes(shape);
      const point: Vec3 = [0, 0, shape.height / 2];
      const normal = keycapNormal(point, shapePlanes, 0.015, shape);
      expect(dot(normal, shapePlanes[0].normal)).toBeCloseTo(1, 4);
    },
  );

  it.each(
    [ratios, { ...ratios, height: 0.65, radius: 0.09, face: 0.72 }].flatMap(
      (shape) => (["angle", "front"] as const).map((view) => ({ shape, view })),
    ),
  )(
    "removes redundant intersection planes without changing hits",
    ({ shape, view }) => {
      const all = keycapPlanes(shape);
      const compact = compactIntersectionPlanes(all);
      expect(compact.length).toBeLessThan(all.length);
      const layout = layoutKeycap({ size: 100, view, ratios: shape });
      for (let y = 0; y < layout.height; y += 9) {
        for (let x = 0; x < layout.width; x += 9) {
          const ray = rayForPixel(
            x,
            y,
            layout.originX,
            layout.originY,
            layout.scalePx,
            layout.camera,
          );
          const expected = intersectKeycap(ray.origin, ray.direction, all);
          const actual = intersectKeycap(ray.origin, ray.direction, compact);
          expect(actual === null).toBe(expected === null);
          if (actual && expected) expect(actual.t).toBeCloseTo(expected.t, 7);
        }
      }
    },
  );

  it.each(["angle", "front"] as const)(
    "precomputes perspective intersections for %s",
    (view) => {
      const layout = layoutKeycap({ size: 100, view });
      const rayAt = createPixelRayFactory(
        layout.originX,
        layout.originY,
        100,
        layout.camera,
      );
      const intersect = createKeycapIntersector(planes, rayAt(0, 0).origin);
      let hits = 0;
      for (let y = 0; y < layout.height; y += 5) {
        for (let x = 0; x < layout.width; x += 5) {
          const ray = rayAt(x, y);
          const first = intersectKeycap(ray.origin, ray.direction, planes);
          const second = intersect(ray.direction);
          expect(first === null).toBe(second === null);
          if (first && second) {
            hits += 1;
            expect(first.t).toBeCloseTo(second.t, 9);
            first.point.forEach((value, i) =>
              expect(value).toBeCloseTo(second.point[i], 9),
            );
          }
        }
      }
      expect(hits).toBeGreaterThan(100);
    },
  );

  it("hits a ray down the middle and misses a ray out in the margin", () => {
    const middle = intersectKeycap([0, 0, 4], [0, 0, -1], planes);
    expect(middle).not.toBe(null);
    expect(middle?.point[2]).toBeCloseTo(ratios.height / 2, 6);
    expect(intersectKeycap([3, 0, 4], [0, 0, -1], planes)).toBe(null);
  });

  it("solves the silhouette from the planes, so corners stay square", () => {
    // A ray just inside the base corner must land, and one just outside must
    // not. A rounded blob fails one of these.
    const inside = intersectKeycap([0.46, 0.46, 4], [0, 0, -1], planes);
    expect(inside).not.toBe(null);
    const outside = intersectKeycap([0.54, 0.54, 4], [0, 0, -1], planes);
    expect(outside).toBe(null);
  });

  it("gives the top face an up normal and the left wall a leftward one", () => {
    const roll = Math.max(ratios.radius * 0.1, 0.008);
    const onTop = keycapNormal([0, 0, ratios.height / 2], planes, roll, ratios);
    expect(onTop[2]).toBeGreaterThan(0.9);
    const onLeft = keycapNormal([-0.5, 0, 0], planes, roll, ratios);
    expect(onLeft[0]).toBeLessThan(-0.7);
    const onRight = keycapNormal([0.5, 0, 0], planes, roll, ratios);
    expect(onRight[0]).toBeGreaterThan(0.7);
  });

  it("does not flatten wall normals with the dish away from the face", () => {
    const hit = intersectKeycap([-2, 0, 0], [1, 0, 0], planes);
    expect(hit).not.toBeNull();
    if (!hit) return;
    const roll = 0.015;
    const flat = keycapNormal(hit.point, planes, roll, { ...ratios, dish: 0 });
    const dished = keycapNormal(hit.point, planes, roll, ratios);
    expect(dot(flat, dished)).toBeCloseTo(1, 6);
  });

  it("does not overweight a shoulder when its wall plane is duplicated", () => {
    const hit = intersectKeycap(
      [-2, 0, ratios.height / 2 - 0.01],
      [1, 0, 0],
      planes,
    );
    expect(hit).not.toBeNull();
    if (!hit) return;
    const flat = { ...ratios, dish: 0 };
    const full = createKeycapNormalSampler(planes, 0.015, flat)(hit.point);
    const compact = createKeycapNormalSampler(
      compactIntersectionPlanes(planes),
      0.015,
      flat,
    )(hit.point);
    expect(dot(full, compact)).toBeCloseTo(1, 7);
  });

  it("keeps negligible normal contributions below visible precision", () => {
    const flat = { ...ratios, dish: 0 };
    const layout = layoutKeycap({ size: 100, view: "angle", ratios: flat });
    const roll = Math.max(flat.radius * 0.12, 0.008);
    for (let y = 5; y < layout.height; y += 7) {
      for (let x = 5; x < layout.width; x += 7) {
        const ray = rayForPixel(
          x,
          y,
          layout.originX,
          layout.originY,
          layout.scalePx,
          layout.camera,
        );
        const hit = intersectKeycap(ray.origin, ray.direction, planes);
        if (!hit) continue;
        const expected = referenceNormal(hit.point, planes, roll);
        const actual = keycapNormal(hit.point, planes, roll, flat);
        for (let i = 0; i < 3; i += 1)
          expect(actual[i]).toBeCloseTo(expected[i], 7);
      }
    }
  });

  it("dishes the top face, so its normal leans outward from the middle", () => {
    const roll = Math.max(ratios.radius * 0.1, 0.008);
    const middle = keycapNormal(
      [0, 0, ratios.height / 2],
      planes,
      roll,
      ratios,
    );
    const towardsEdge = keycapNormal(
      [ratios.face * 0.3, 0, ratios.height / 2],
      planes,
      roll,
      ratios,
    );
    // Dead centre points straight up; towards the rim it leans outwards, which
    // is what lights the shoulder band instead of the middle of the face.
    expect(Math.abs(middle[0])).toBeLessThan(0.02);
    expect(towardsEdge[0]).toBeGreaterThan(0.1);
  });

  it("shades every normal to a finite tone, whatever the angle", () => {
    const view: Vec3 = [0, -0.6, 0.8];
    for (const plane of planes) {
      const shade = shadeKeycap(plane.normal, view);
      expect(Number.isFinite(shade.level)).toBe(true);
      expect(Number.isFinite(shade.specular)).toBe(true);
      const [r, g, b] = plasticAt(shade, 0.05, 0.5);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
    }
  });

  it("lights the left wall brighter than the right, like the reference", () => {
    const view: Vec3 = [0, -0.6, 0.8];
    const left = shadeKeycap([-1, 0, 0], view).level;
    const right = shadeKeycap([1, 0, 0], view).level;
    // The key light sits on the viewer's left, which is what makes the left
    // wall read as lit and the right wall fall away.
    expect(left).toBeGreaterThan(right);
    expect(left).toBeGreaterThan(0.6);
    // A fill light keeps the right wall from going pure black, but it stays
    // several stops under the key side.
    expect(right).toBeGreaterThan(0);
    expect(right).toBeLessThan(left / 3);
  });

  it("positions the legend at the intersected top face centre", () => {
    const layout = layoutKeycap({ size: 200, view: "angle" });
    const centre = toCameraSpace(
      [0, 0, layout.ratios.height / 2],
      layout.camera,
    );
    const distance = layout.camera.perspective;
    if (distance === null) throw new Error("Expected a perspective camera");
    const screenY =
      layout.originY +
      ((centre[1] * distance) / (distance - centre[2])) * layout.scalePx;
    expect(layout.faceCentreY).toBeCloseTo(screenY - layout.height / 2, 6);
  });

  it("keeps the matte crease restrained and the near wall darker than the left wall", () => {
    const view: Vec3 = [-0.3, 0.79, 0.54];
    const value = (normal: Vec3, occlusion: number) =>
      plasticAt(shadeKeycap(normal, view, occlusion), 0, 0.5)[0];
    const left = value([-0.94, 0.02, 0.33], 1);
    const near = value([0.02, 0.96, 0.29], 0.8);
    const crease = value([-0.05, 0.79, 0.61], 1);
    expect(left).toBeGreaterThan(near + 15);
    expect(crease).toBeGreaterThan(left);
    expect(crease).toBeLessThan(125);
    expect(near).toBeLessThan(65);
  });

  it("attenuates every highlight under contact occlusion", () => {
    const normal: Vec3 = [-0.3, 0.79, 0.54];
    const view: Vec3 = [-0.3, 0.79, 0.54];
    const lit = shadeKeycap(normal, view, 1);
    const dimmed = shadeKeycap(normal, view, 0.5);
    expect(lit.specular).toBeGreaterThan(0);
    expect(dimmed.specular).toBeCloseTo(lit.specular * 0.5, 10);
    expect(dimmed.level).toBeCloseTo(lit.level * 0.5, 10);
  });

  it("fades the crease reflection towards the right side of the cap", () => {
    const normal: Vec3 = [-0.05, 0.79, 0.61];
    const view: Vec3 = [-0.3, 0.79, 0.54];
    const left = shadeKeycap(normal, view, 1, [-0.4, 0.4, 0.1]);
    const right = shadeKeycap(normal, view, 1, [0.4, 0.4, 0.1]);
    expect(left.specular).toBeGreaterThan(right.specular * 2);
  });

  it("projects both face axes and the face centre through the camera", () => {
    const layout = layoutKeycap({ size: 200, view: "angle" });
    const { camera, ratios } = layout;
    const project = (point: Vec3) => {
      const transformed = toCameraSpace(point, camera);
      const distance = camera.perspective;
      if (distance === null) throw new Error("Expected a perspective camera");
      const scale = distance / (distance - transformed[2]);
      return [transformed[0] * scale, transformed[1] * scale];
    };
    const faceHeight = ratios.height / 2;
    const centre = project([0, 0, faceHeight]);
    const step = 0.0001;
    const x = project([step, 0, faceHeight]);
    const y = project([
      0,
      step,
      faceHeight - Math.tan((ratios.faceTilt * Math.PI) / 180) * step,
    ]);
    expect(layout.faceCentreX).toBeCloseTo(
      layout.originX + centre[0] * 200 - layout.width / 2,
      6,
    );
    expect(layout.faceCentreY).toBeCloseTo(
      layout.originY + centre[1] * 200 - layout.height / 2,
      6,
    );
    expect(layout.faceMatrix[0]).toBeCloseTo((x[0] - centre[0]) / step, 4);
    expect(layout.faceMatrix[1]).toBeCloseTo((x[1] - centre[1]) / step, 4);
    expect(layout.faceMatrix[2]).toBeCloseTo((y[0] - centre[0]) / step, 4);
    expect(layout.faceMatrix[3]).toBeCloseTo((y[1] - centre[1]) / step, 4);
  });

  it.each([
    { size: 190, view: "angle" as const, perspectiveFactor: 3 },
    { size: 34, view: "front" as const, perspectiveFactor: 20 },
    { size: 96, view: "angle" as const, perspectiveFactor: 0 },
  ])(
    "projects the full face at $size px with perspective $perspectiveFactor",
    (options) => {
      const layout = layoutKeycap(options);
      const faceHeight = layout.ratios.height / 2;
      const project = (point: Vec3) => {
        const camera = toCameraSpace(point, layout.camera);
        const distance = layout.camera.perspective;
        const factor =
          distance === null || distance === 0
            ? 1
            : distance / (distance - camera[2]);
        return [camera[0] * factor, camera[1] * factor];
      };
      const centre = project([0, 0, faceHeight]);
      for (const [x, y] of [
        [-0.3, -0.25],
        [0.3, -0.25],
        [-0.3, 0.25],
        [0.3, 0.25],
      ]) {
        const projected = project([
          x,
          y,
          faceHeight - Math.tan((layout.ratios.faceTilt * Math.PI) / 180) * y,
        ]);
        const px = x * options.size;
        const py = y * options.size;
        const [a, b, c, verticalY] = layout.faceMatrix;
        const [wx, wy] = layout.facePerspective;
        const divisor = 1 + wx * px + wy * py;
        expect((a * px + c * py) / divisor).toBeCloseTo(
          (projected[0] - centre[0]) * options.size,
          6,
        );
        expect((b * px + verticalY * py) / divisor).toBeCloseTo(
          (projected[1] - centre[1]) * options.size,
          6,
        );
      }
    },
  );

  it("applies screen roll after the camera tilt and reverses it for rays", () => {
    const camera = { tilt: 58, spin: -30, roll: 12, perspective: 20 };
    const withoutRoll = { ...camera, roll: 0 };
    const point: Vec3 = [0.3, -0.2, 0.1];
    const base = toCameraSpace(point, withoutRoll);
    const rotated = toCameraSpace(point, camera);
    const angle = (12 * Math.PI) / 180;
    expect(rotated[0]).toBeCloseTo(
      base[0] * Math.cos(angle) - base[1] * Math.sin(angle),
      9,
    );
    expect(rotated[1]).toBeCloseTo(
      base[0] * Math.sin(angle) + base[1] * Math.cos(angle),
      9,
    );
    const roundTrip = fromCameraSpace(rotated, camera);
    point.forEach((v, i) => expect(roundTrip[i]).toBeCloseTo(v, 9));
  });

  it.each([20, null])(
    "precomputes pixel rays without changing the camera projection (%s)",
    (perspective) => {
      const camera = { tilt: 58, spin: -30, roll: 12, perspective };
      const rayAt = createPixelRayFactory(120, 110, 200, camera);
      for (const [x, y] of [
        [0, 0],
        [120, 110],
        [240, 220],
      ]) {
        const expected = rayForPixel(x, y, 120, 110, 200, camera);
        const actual = rayAt(x, y);
        for (let i = 0; i < 3; i += 1) {
          expect(actual.origin[i]).toBeCloseTo(expected.origin[i], 9);
          expect(actual.direction[i]).toBeCloseTo(expected.direction[i], 9);
        }
      }
    },
  );

  it.each([20, null])(
    "uses the inverse ray direction as the view vector (%s)",
    (perspective) => {
      const layout = layoutKeycap({ size: 100, view: "angle" });
      const camera = { ...layout.camera, perspective };
      const planes = keycapPlanes(layout.ratios);
      const rayAt = createPixelRayFactory(
        layout.originX,
        layout.originY,
        100,
        camera,
      );
      let hits = 0;
      for (let y = 0; y < layout.height; y += 7) {
        for (let x = 0; x < layout.width; x += 7) {
          const ray = rayAt(x, y);
          const hit = intersectKeycap(ray.origin, ray.direction, planes);
          if (!hit) continue;
          hits += 1;
          const view = normalize([
            ray.origin[0] - hit.point[0],
            ray.origin[1] - hit.point[1],
            ray.origin[2] - hit.point[2],
          ]);
          view.forEach((value, i) =>
            expect(value).toBeCloseTo(-ray.direction[i], 9),
          );
        }
      }
      expect(hits).toBeGreaterThan(50);
    },
  );

  it("gives each view its own camera, and lets callers override it", () => {
    expect(layoutKeycap({ size: 100, view: "angle" }).camera.tilt).toBe(
      ANGLE_VIEW.tilt,
    );
    const front = layoutKeycap({ size: 100, view: "front" });
    // The dashboard cap is nearly a front elevation, but a small tilt keeps a
    // strip of the near wall so it still reads as a solid object.
    expect(front.camera.tilt).toBe(FRONT_VIEW.tilt);
    expect(front.camera.spin).toBe(0);
    expect(front.camera.roll).toBe(0);
    expect(front.camera.perspective).toBe(FRONT_VIEW.perspectiveFactor);
    expect(layoutKeycap({ size: 100, view: "angle" }).camera.roll).toBe(
      ANGLE_VIEW.roll,
    );

    const custom = layoutKeycap({
      size: 100,
      view: "front",
      tilt: 40,
      roll: -8,
    });
    expect(custom.camera.tilt).toBe(40);
    expect(custom.camera.roll).toBe(-8);
    expect(custom.height).toBeGreaterThan(front.height);
  });
});
