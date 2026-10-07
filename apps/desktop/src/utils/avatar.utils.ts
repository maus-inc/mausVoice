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

export const ACCEPTED_AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Value for the file input's `accept`, so the picker filters by default. */
export const AVATAR_FILE_ACCEPT = ACCEPTED_AVATAR_MIME_TYPES.join(",");

export type AvatarReadError = "unsupported-type" | "too-large" | "unreadable";

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

    const dataUrl = usesTransparency(context, AVATAR_IMAGE_SIZE)
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.9);

    return { ok: true, dataUrl };
  } catch {
    // A file that declares an accepted type can still fail to decode, which is
    // the one path here that is not the person's fault and must not surface as
    // an unhandled rejection.
    return { ok: false, error: "unreadable" };
  }
};
