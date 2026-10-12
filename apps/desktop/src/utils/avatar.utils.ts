/**
 * Turning a chosen image file into the small square the app stores.
 *
 * The profile photo is persisted with the rest of the local app state, so it is
 * downscaled and re-encoded here instead of being kept at whatever size the
 * file happened to be: a 6 MB photo carried around in the store would be
 * re-serialized on every state change and would eventually blow the storage
 * quota. One 256px square is enough for every place the avatar appears, from
 * the 24px chip in the title bar to the 96px preview in the editor.
 */

export const MAX_AVATAR_SOURCE_BYTES = 5 * 1024 * 1024;

/** Edge length of the stored image, in pixels. */
export const AVATAR_IMAGE_SIZE = 256;

/** Quality of the stored JPEG. High enough that a photo does not look softened. */
export const AVATAR_JPEG_QUALITY = 0.9;

/**
 * The largest stored data URL the app will keep, in characters.
 *
 * The photo lives in the persisted local slice, which the store re-serializes
 * and writes on every change, so this string is what decides how much of the
 * origin's storage quota one picture may take. A 256px JPEG lands around 30 KB,
 * and a PNG that keeps alpha on busy content can be an order of magnitude
 * larger, which is the case this cap exists for.
 */
export const MAX_STORED_AVATAR_CHARS = 200_000;

export const ACCEPTED_AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Value for the file input's `accept`, so the picker filters by default. */
export const AVATAR_FILE_ACCEPT = ACCEPTED_AVATAR_MIME_TYPES.join(",");

export type AvatarReadError =
  "unsupported-type" | "too-large" | "too-many-pixels" | "unreadable";

export type AvatarReadResult =
  { ok: true; dataUrl: string } | { ok: false; error: AvatarReadError };

/**
 * The largest square that fits inside an image, centred.
 *
 * Cropping to a square is what makes a rectangular photo safe to show in a
 * circle: the alternative is stretching it, which is what the avatar would
 * otherwise do with `object-fit: cover` at every size. Centre is the right
 * default because faces sit in the middle of photos, and it is the crop the
 * preview in the editor shows, so what someone approves is what gets stored.
 */
export const computeSquareCrop = (
  width: number,
  height: number,
): { x: number; y: number; side: number } => {
  const side = Math.min(width, height);
  return { x: (width - side) / 2, y: (height - side) / 2, side };
};

/**
 * The reason a file cannot be used, or null when it can.
 *
 * Split from the decode so the gate answers before any work happens, and so the
 * message the person sees names the actual problem rather than "something went
 * wrong".
 */
export const validateAvatarFile = (file: {
  type: string;
  size: number;
}): AvatarReadError | null => {
  if (!(ACCEPTED_AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "unsupported-type";
  }
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    return "too-large";
  }
  return null;
};

/**
 * The largest source image the decoder will be asked to open, in pixels.
 *
 * The byte cap above does not bound the decode. A few kilobytes of PNG header
 * can declare a 30000x30000 canvas, and the decoder allocates the whole
 * decoded bitmap before any crop happens — 3.6 GB of RGBA in that example,
 * which is the app dying rather than a photo being refused. So the size the
 * header declares is read first, and the decode only runs for an image that
 * fits here. 40 MP is beyond any camera this app will meet and small enough
 * that the allocation cannot take the window down.
 */
export const MAX_AVATAR_SOURCE_PIXELS = 40_000_000;

/** How much of a file the header readers get to look at. */
const READ_HEADER_BYTES = 4096;

type AvatarSourceSize = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const asciiAt = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** A PNG's size is fixed in IHDR, which is always the first chunk. */
const readPngSize = (
  bytes: Uint8Array,
  view: DataView,
): AvatarSourceSize | null => {
  const signature = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  if (!signature || bytes.length < 24) {
    return null;
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/**
 * JPEG start-of-frame markers, which are the only place a JPEG states its size.
 * 0xC4, 0xC8 and 0xCC are excluded because they are tables, not frames.
 */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Walks a JPEG's segment chain to its frame header, then reads the size. */
const readJpegSize = (
  bytes: Uint8Array,
  view: DataView,
): AvatarSourceSize | null => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length: fill bytes, restart markers, and
    // the start of image itself.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      // A file cut off inside the frame header would make the reads below
      // throw, so a truncated frame is treated like any other header this
      // reader cannot make sense of.
      if (offset + 9 > bytes.length) {
        return null;
      }
      return {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
      };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) {
      return null;
    }
    offset += 2 + length;
  }
  return null;
};

/** WebP keeps its size in the chunk that comes first: VP8X, VP8 or VP8L. */
const readWebpSize = (
  bytes: Uint8Array,
  view: DataView,
): AvatarSourceSize | null => {
  if (
    bytes.length < 30 ||
    asciiAt(bytes, 0) !== "RIFF" ||
    asciiAt(bytes, 8) !== "WEBP"
  ) {
    return null;
  }
  const format = asciiAt(bytes, 12);
  if (format === "VP8X") {
    return {
      width:
        1 +
        view.getUint8(24) +
        (view.getUint8(25) << 8) +
        (view.getUint8(26) << 16),
      height:
        1 +
        view.getUint8(27) +
        (view.getUint8(28) << 8) +
        (view.getUint8(29) << 16),
    };
  }
  if (format === "VP8 ") {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
};

/**
 * The size a file's header declares, or null when it cannot be read.
 *
 * Fail-open on purpose: a format quirk this parser does not recognise falls
 * through to the decode path, where the byte cap still applies. The guard is
 * here to stop a declared size from being turned into an allocation, not to
 * become the newest way a real photo gets refused.
 */
const readDeclaredSize = async (
  file: File,
): Promise<AvatarSourceSize | null> => {
  const bytes = new Uint8Array(
    await file.slice(0, READ_HEADER_BYTES).arrayBuffer(),
  );
  const view = new DataView(bytes.buffer);
  return (
    readPngSize(bytes, view) ??
    readJpegSize(bytes, view) ??
    readWebpSize(bytes, view)
  );
};

/**
 * Whether the drawn image uses transparency anywhere.
 *
 * A PNG cutout encodes as a JPEG against a filled background, which looks like
 * a grey box on the dark theme. Keeping the alpha channel for those and using
 * JPEG for everything else keeps the common case (a photo) small.
 */
const usesTransparency = (
  context: CanvasRenderingContext2D,
  size: number,
): boolean => {
  const { data } = context.getImageData(0, 0, size, size);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) {
      return true;
    }
  }
  return false;
};

/**
 * The drawn square as the string that gets stored.
 *
 * Alpha is worth keeping while it is affordable: a cutout encodes small as PNG,
 * and the same pixels as JPEG would turn transparent areas black. A photo with
 * a few semi-transparent pixels, though, takes the PNG branch at many times the
 * JPEG's size, so anything over the cap is encoded as a JPEG instead, with the
 * pixels painted onto white first so a cutout becomes a light picture rather
 * than a dark rectangle.
 */
const encodeSquare = (
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): string => {
  if (usesTransparency(context, AVATAR_IMAGE_SIZE)) {
    const png = canvas.toDataURL("image/png");
    if (png.length <= MAX_STORED_AVATAR_CHARS) {
      return png;
    }
    // `destination-over` paints behind the pixels already drawn, so the
    // transparent ones get white instead of black.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_IMAGE_SIZE, AVATAR_IMAGE_SIZE);
    context.globalCompositeOperation = "source-over";
  }

  return canvas.toDataURL("image/jpeg", AVATAR_JPEG_QUALITY);
};

/**
 * Read a chosen file into the stored square, or say why it cannot be used.
 *
 * `imageOrientation: "from-image"` matters for photos taken on a phone: their
 * pixels are often stored sideways and the rotation lives in EXIF, which a
 * canvas draw ignores.
 */
export const readAvatarFile = async (file: File): Promise<AvatarReadResult> => {
  const invalid = validateAvatarFile(file);
  if (invalid) {
    return { ok: false, error: invalid };
  }

  try {
    // Reading the header is part of reading the file: a parse that throws is
    // the same "cannot read this" as a decode that throws, not a new failure
    // for the caller to handle.
    const declared = await readDeclaredSize(file);
    if (
      declared &&
      declared.width * declared.height > MAX_AVATAR_SOURCE_PIXELS
    ) {
      return { ok: false, error: "too-many-pixels" };
    }

    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const { x, y, side } = computeSquareCrop(bitmap.width, bitmap.height);

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_IMAGE_SIZE;
    canvas.height = AVATAR_IMAGE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return { ok: false, error: "unreadable" };
    }

    context.drawImage(
      bitmap,
      x,
      y,
      side,
      side,
      0,
      0,
      AVATAR_IMAGE_SIZE,
      AVATAR_IMAGE_SIZE,
    );
    bitmap.close();

    return { ok: true, dataUrl: encodeSquare(canvas, context) };
  } catch {
    // A file that declares an accepted type can still fail to decode, which is
    // the one path here that is not the person's fault and must not surface as
    // an unhandled rejection.
    return { ok: false, error: "unreadable" };
  }
};
