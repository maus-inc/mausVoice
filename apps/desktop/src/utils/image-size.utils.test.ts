// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readDeclaredImageSize } from "./image-size.utils";

/**
 * The app accepts three formats and reads the size each one declares in its
 * header, because that number is what decides whether the decoder may be
 * called at all. These are the headers themselves — the odd shapes a real file
 * arrives in, and what has to come back for each — rather than the pipeline
 * that uses them.
 */

/** A PNG whose IHDR declares a size. Nothing after it is a real image. */
const pngFile = (width = 1200, height = 800) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], "photo.png", { type: "image/png" });
};

/**
 * A JPEG whose frame header sits behind an APP1 segment of `padding` bytes,
 * the way a phone photo's EXIF does.
 */
const paddedJpegFile = ({
  width,
  height,
  padding,
  fillBytes = 0,
}: {
  width: number;
  height: number;
  padding: number;
  fillBytes?: number;
}) => {
  const segmentLength = 2 + padding;
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe1,
    segmentLength >> 8,
    segmentLength & 0xff,
    ...Array.from({ length: padding }, () => 0x00),
    // Legal in a JPEG: any number of 0xFF bytes may pad a marker. An odd run
    // shifts the marker by one byte, which is the case a reader stepping over
    // fill bytes in pairs gets wrong.
    ...Array.from({ length: fillBytes }, () => 0xff),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ];
  return new File([new Uint8Array(bytes)], "photo.jpg", {
    type: "image/jpeg",
  });
};

/** A 25-byte lossless WebP: the smallest header the format allows. */
const tinyWebpFile = () => {
  const bytes = new Uint8Array(25);
  bytes.set(
    [..."RIFF"].map((char) => char.charCodeAt(0)),
    0,
  );
  bytes.set(
    [..."WEBP"].map((char) => char.charCodeAt(0)),
    8,
  );
  bytes.set(
    [..."VP8L"].map((char) => char.charCodeAt(0)),
    12,
  );
  new DataView(bytes.buffer).setUint32(16, 5, true);
  new DataView(bytes.buffer).setUint32(21, 0, true);
  return new File([bytes], "photo.webp", { type: "image/webp" });
};

const sizeOf = async (file: File) => readDeclaredImageSize(file);

describe("readDeclaredImageSize", () => {
  it("reads a PNG's size out of IHDR", async () => {
    expect(await sizeOf(pngFile(1200, 800))).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it("reads a JPEG's size out of its frame header", async () => {
    expect(
      await sizeOf(paddedJpegFile({ width: 640, height: 480, padding: 8 })),
    ).toEqual({ width: 640, height: 480 });
  });

  it("finds a JPEG's size behind a long EXIF segment", async () => {
    // 6 KB of APP1 in front of the frame header: past the first window the
    // reader takes, inside the one it falls back to.
    expect(
      await sizeOf(
        paddedJpegFile({ width: 30_000, height: 30_000, padding: 6_000 }),
      ),
    ).toEqual({ width: 30_000, height: 30_000 });
  });

  it("reads the frame header past an odd run of fill bytes", async () => {
    // Three 0xFF fill bytes in front of the frame marker: the marker itself
    // starts one byte later than a reader that treats fill bytes as pairs
    // expects, so a wrong reader lands on a length field and walks off.
    expect(
      await sizeOf(
        paddedJpegFile({
          width: 30_000,
          height: 30_000,
          padding: 16,
          fillBytes: 3,
        }),
      ),
    ).toEqual({ width: 30_000, height: 30_000 });
  });

  it("reads a tiny lossless WebP", async () => {
    // 25 bytes: RIFF size, WEBP, a VP8L chunk, and the dimensions. Refusing it
    // for being shorter than the extended-header case would refuse a real file.
    expect(await sizeOf(tinyWebpFile())).toEqual({ width: 1, height: 1 });
  });

  it("says nothing rather than reading past a truncated frame header", async () => {
    const truncated = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00])],
      "photo.jpg",
      { type: "image/jpeg" },
    );

    expect(await sizeOf(truncated)).toBeNull();
  });

  it("says nothing about a file with no header it recognises", async () => {
    expect(
      await sizeOf(new File(["x"], "photo.png", { type: "image/png" })),
    ).toBeNull();
  });

  it("walks past a zero-length segment instead of looping on it", async () => {
    // A length field of zero would step nowhere; the walk has to end.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    expect(
      await sizeOf(new File([bytes], "photo.jpg", { type: "image/jpeg" })),
    ).toBeNull();
  });
});
