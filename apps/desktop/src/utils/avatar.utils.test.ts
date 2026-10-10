// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_IMAGE_SIZE,
  AVATAR_JPEG_QUALITY,
  computeSquareCrop,
  MAX_AVATAR_SOURCE_BYTES,
  MAX_STORED_AVATAR_CHARS,
  readAvatarFile,
  validateAvatarFile,
} from "./avatar.utils";

/**
 * The avatar pipeline decides what a chosen file becomes before it is stored,
 * and it is the one place in the app that turns a file into persisted state. The
 * crop, the file gate and the encode are all pinned here: jsdom has no canvas,
 * so the encode is driven through a stub that records what the pipeline drew and
 * what it asked the canvas to encode.
 */
describe("computeSquareCrop", () => {
  it("takes the centre square of a landscape photo", () => {
    expect(computeSquareCrop(1200, 800)).toEqual({
      x: 200,
      y: 0,
      side: 800,
    });
  });

  it("takes the centre square of a portrait photo", () => {
    expect(computeSquareCrop(800, 1200)).toEqual({
      x: 0,
      y: 200,
      side: 800,
    });
  });

  it("leaves a square image alone", () => {
    expect(computeSquareCrop(512, 512)).toEqual({ x: 0, y: 0, side: 512 });
  });

  it("never crops outside the image", () => {
    for (const [width, height] of [
      [1, 9000],
      [9000, 1],
      [3, 3],
      [640, 480],
    ]) {
      const { x, y, side } = computeSquareCrop(width, height);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + side).toBeLessThanOrEqual(width);
      expect(y + side).toBeLessThanOrEqual(height);
    }
  });
});

describe("validateAvatarFile", () => {
  it("accepts the three formats the picker offers", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateAvatarFile({ type, size: 1000 })).toBeNull();
    }
  });

  it("refuses a file that is not an image", () => {
    expect(validateAvatarFile({ type: "application/pdf", size: 1000 })).toBe(
      "unsupported-type",
    );
    expect(validateAvatarFile({ type: "", size: 1000 })).toBe(
      "unsupported-type",
    );
  });

  it("refuses an image over the size limit and keeps the boundary", () => {
    expect(
      validateAvatarFile({ type: "image/png", size: MAX_AVATAR_SOURCE_BYTES }),
    ).toBeNull();
    expect(
      validateAvatarFile({
        type: "image/png",
        size: MAX_AVATAR_SOURCE_BYTES + 1,
      }),
    ).toBe("too-large");
  });

  it("reports the type before the size, because it is the fixable one", () => {
    expect(
      validateAvatarFile({
        type: "video/mp4",
        size: MAX_AVATAR_SOURCE_BYTES * 4,
      }),
    ).toBe("unsupported-type");
  });
});

type CanvasStub = {
  context: CanvasRenderingContext2D;
  calls: {
    drawImage: unknown[][];
    toDataUrl: { type: string; quality?: number }[];
    fills: { fillStyle: string; composite: string }[];
  };
};

/**
 * A canvas that answers the four things the pipeline asks of one, and records
 * the rest. `transparent` decides what the alpha scan finds, and `pngLength`
 * sets how large the PNG encoder pretends its output is. The length the app
 * measures is `PNG_DATA_URL_PREFIX.length + pngLength`, which is what the
 * budget cases below are written against.
 */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const installCanvas = ({
  transparent = false,
  pngLength = 1_000,
}: { transparent?: boolean; pngLength?: number } = {}): CanvasStub => {
  const calls: CanvasStub["calls"] = {
    drawImage: [],
    toDataUrl: [],
    fills: [],
  };
  const pixels = new Uint8ClampedArray(
    AVATAR_IMAGE_SIZE * AVATAR_IMAGE_SIZE * 4,
  );
  pixels.fill(255);
  if (transparent) {
    pixels[3] = 120;
  }

  const context = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    drawImage: (...args: unknown[]) => calls.drawImage.push(args),
    getImageData: () => ({ data: pixels }),
    fillRect: () =>
      calls.fills.push({
        fillStyle: String(context.fillStyle),
        composite: String(context.globalCompositeOperation),
      }),
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: (type: string, quality?: number) => {
      calls.toDataUrl.push({ type, quality });
      return type === "image/png"
        ? `${PNG_DATA_URL_PREFIX}${"A".repeat(pngLength)}`
        : "data:image/jpeg;base64,JPEG";
    },
  } as unknown as HTMLCanvasElement;

  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag !== "canvas") {
      throw new Error(`Unexpected element requested: ${tag}`);
    }
    return canvas as unknown as HTMLElement;
  });

  return { context, calls };
};

const installBitmap = (width = 1200, height = 800) => {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width, height, close }));
  vi.stubGlobal("createImageBitmap", decode);
  return { close, decode };
};

const pngFile = () => new File(["x"], "photo.png", { type: "image/png" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("readAvatarFile", () => {
  it("draws the centre square and stores a JPEG for an opaque photo", async () => {
    const canvas = installCanvas();
    const bitmap = installBitmap(1200, 800);
    const file = pngFile();

    const result = await readAvatarFile(file);

    // The rotation of a photo taken on a phone lives in its EXIF, which a canvas
    // draw ignores; without this option the square comes out sideways.
    expect(bitmap.decode).toHaveBeenCalledWith(file, {
      imageOrientation: "from-image",
    });

    expect(result).toEqual({
      ok: true,
      dataUrl: "data:image/jpeg;base64,JPEG",
    });
    // 200, 0, 800, 800 of the source into the whole 256px square.
    expect(canvas.calls.drawImage[0]).toEqual([
      { width: 1200, height: 800, close: expect.any(Function) },
      200,
      0,
      800,
      800,
      0,
      0,
      AVATAR_IMAGE_SIZE,
      AVATAR_IMAGE_SIZE,
    ]);
    expect(canvas.calls.toDataUrl).toEqual([
      { type: "image/jpeg", quality: AVATAR_JPEG_QUALITY },
    ]);
  });

  it("keeps alpha as a PNG while the encoded image fits the budget", async () => {
    const canvas = installCanvas({ transparent: true, pngLength: 1_000 });
    installBitmap(512, 512);

    const result = await readAvatarFile(pngFile());

    expect(result.ok && result.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(canvas.calls.toDataUrl).toEqual([{ type: "image/png" }]);
    // Nothing was flattened, because nothing had to be.
    expect(canvas.calls.fills).toEqual([]);
  });

  // The budget is inclusive: a PNG exactly at the cap is still affordable, and
  // a `<` where the rule says `<=` would re-encode it for nothing.
  it("keeps a transparent PNG that lands exactly on the budget", async () => {
    const canvas = installCanvas({
      transparent: true,
      pngLength: MAX_STORED_AVATAR_CHARS - PNG_DATA_URL_PREFIX.length,
    });
    installBitmap(512, 512);

    const result = await readAvatarFile(pngFile());

    // The cap the encoder compares against is the whole string, not the payload.
    expect(result.ok && result.dataUrl.length).toBe(MAX_STORED_AVATAR_CHARS);
    expect(result.ok && result.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(canvas.calls.toDataUrl).toEqual([{ type: "image/png" }]);
    expect(canvas.calls.fills).toEqual([]);
  });

  it("falls back to a JPEG on white when a transparent PNG is too large", async () => {
    const canvas = installCanvas({
      transparent: true,
      pngLength: MAX_STORED_AVATAR_CHARS - PNG_DATA_URL_PREFIX.length + 1,
    });
    installBitmap(512, 512);

    const result = await readAvatarFile(pngFile());

    expect(result).toEqual({
      ok: true,
      dataUrl: "data:image/jpeg;base64,JPEG",
    });
    // The white wash goes behind the pixels, not over them.
    expect(canvas.calls.fills).toEqual([
      { fillStyle: "#ffffff", composite: "destination-over" },
    ]);
    expect(canvas.calls.toDataUrl).toEqual([
      { type: "image/png" },
      { type: "image/jpeg", quality: AVATAR_JPEG_QUALITY },
    ]);
  });

  it("reports a file it cannot decode instead of rejecting", async () => {
    installCanvas();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );

    expect(await readAvatarFile(pngFile())).toEqual({
      ok: false,
      error: "unreadable",
    });
  });

  it("refuses an unsupported type before touching the decoder", async () => {
    installCanvas();
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    const result = await readAvatarFile(
      new File(["x"], "notes.txt", { type: "text/plain" }),
    );

    expect(result).toEqual({ ok: false, error: "unsupported-type" });
    expect(decode).not.toHaveBeenCalled();
  });
});
