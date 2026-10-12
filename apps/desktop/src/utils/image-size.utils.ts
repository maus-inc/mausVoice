/**
 * What size an image file says it is, read from its own header.
 *
 * The app accepts PNG, JPEG and WebP, and each states its size in the first
 * bytes of the file — PNG in IHDR, JPEG in its frame header, WebP in the chunk
 * that has to come first. Reading it costs one small slice of the file and no
 * decode, which is what makes it usable as a guard: the decoder allocates the
 * whole decoded image, so the size has to be known before it is called rather
 * than after.
 *
 * Everything here is bytes and offsets. What a size is *allowed* to be is the
 * caller's business.
 */

/** How much of a file the header readers get to look at. */
const READ_HEADER_BYTES = 4096;

/**
 * How far into a JPEG the search for its frame header may go.
 *
 * The frame header has to be found, because a JPEG whose size is unknown is a
 * JPEG this app will not open — so the search gets a window far larger than any
 * real EXIF or ICC block, and gives up beyond it rather than reading further.
 */
const MAX_HEADER_SCAN_BYTES = 1_048_576;

export type ImageSourceSize = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The four-character tag a container format writes at this offset. */
const readTagAt = (bytes: Uint8Array, offset: number): string =>
  String.fromCodePoint(...bytes.subarray(offset, offset + 4));

/** A PNG's size is fixed in IHDR, which is always the first chunk. */
const readPngSize = (
  bytes: Uint8Array,
  view: DataView,
): ImageSourceSize | null => {
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

const JPEG_MARKER_PREFIX = 0xff;
const JPEG_START_OF_IMAGE = [0xff, 0xd8] as const;
/** Bytes a frame header needs before its two dimension reads are in range. */
const JPEG_FRAME_HEADER_BYTES = 9;

/** Standalone markers carry no length: fill bytes and restart markers. */
const jpegMarkerIsStandalone = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

/**
 * The size a frame header states, or null when the file ends inside it or the
 * size is not there to read.
 *
 * A file cut off mid-header would make the reads below throw, so a truncated
 * frame is treated like any other header this reader cannot make sense of.
 *
 * A zero dimension is the same answer for a different reason. A JPEG may state
 * height 0 and supply the real one later in a DNL marker, which this walk does
 * not follow; reporting the zero would hand a deliberately zero-area image to
 * the caller's pixel limit, where `0 * 0` passes every ceiling and the file
 * reaches the decoder with nothing bounding the allocation. Unresolved is
 * refused instead, which is what the caller already does with a size it cannot
 * read.
 */
const readJpegFrameSize = (
  bytes: Uint8Array,
  view: DataView,
  offset: number,
): ImageSourceSize | null => {
  if (offset + JPEG_FRAME_HEADER_BYTES > bytes.length) {
    return null;
  }
  const width = view.getUint16(offset + 7);
  const height = view.getUint16(offset + 5);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
};

type JpegSegment = {
  /** The frame's size, when the marker at this offset is a frame header. */
  size: ImageSourceSize | null;
  /** The next offset to look at, or null when the walk is over. */
  next: number | null;
};

/**
 * One step along a JPEG's segment chain: either a frame header (which is what
 * the walk is looking for, and where it ends) or the offset of the segment
 * that follows.
 */
const nextJpegSegment = (
  bytes: Uint8Array,
  view: DataView,
  offset: number,
): JpegSegment => {
  // A byte that is not a marker prefix is padding between segments.
  if (bytes[offset] !== JPEG_MARKER_PREFIX) {
    return { size: null, next: offset + 1 };
  }
  const marker = bytes[offset + 1];
  // A repeated prefix byte is a fill byte — one byte, not a marker pair — so
  // the walk steps over it one byte at a time. Treating it as a pair would
  // walk straight past the marker that follows an odd run of them.
  if (marker === JPEG_MARKER_PREFIX) {
    return { size: null, next: offset + 1 };
  }
  if (jpegMarkerIsStandalone(marker)) {
    return { size: null, next: offset + 2 };
  }
  if (JPEG_FRAME_MARKERS.has(marker)) {
    return { size: readJpegFrameSize(bytes, view, offset), next: null };
  }
  const length = view.getUint16(offset + 2);
  // A segment cannot be shorter than its own length field, and a zero one
  // would loop forever.
  if (length < 2) {
    return { size: null, next: null };
  }
  return { size: null, next: offset + 2 + length };
};

/** Walks a JPEG's segment chain to its frame header, then reads the size. */
const readJpegSize = (
  bytes: Uint8Array,
  view: DataView,
): ImageSourceSize | null => {
  if (
    bytes[0] !== JPEG_START_OF_IMAGE[0] ||
    bytes[1] !== JPEG_START_OF_IMAGE[1]
  ) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    const segment = nextJpegSegment(bytes, view, offset);
    if (segment.size) {
      return segment.size;
    }
    if (segment.next === null) {
      return null;
    }
    offset = segment.next;
  }
  return null;
};

/** WebP keeps its size in the chunk that comes first: VP8X, VP8 or VP8L. */
const readWebpSize = (
  bytes: Uint8Array,
  view: DataView,
): ImageSourceSize | null => {
  if (
    bytes.length < 16 ||
    readTagAt(bytes, 0) !== "RIFF" ||
    readTagAt(bytes, 8) !== "WEBP"
  ) {
    return null;
  }
  const format = readTagAt(bytes, 12);
  // Each variant is read only as far as its own size field reaches: a 1x1
  // lossless WebP is 25 bytes, and refusing it for being shorter than the
  // extended-header case would be refusing a real file.
  if (format === "VP8X" && bytes.length < 30) {
    return null;
  }
  if (format === "VP8 " && bytes.length < 30) {
    return null;
  }
  if (format === "VP8L" && bytes.length < 25) {
    return null;
  }
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
 * A JPEG is the awkward one: its size sits behind however many EXIF, ICC and
 * other segments the camera or the editor wrote in front of the frame header,
 * and those can run past the first window. So a JPEG that is not answered by
 * the small window gets a second one — bytes only, still no decode — and the
 * formats whose size is always in the first chunk are read from the small one.
 */
export const readDeclaredImageSize = async (
  file: File,
): Promise<ImageSourceSize | null> => {
  const head = new Uint8Array(
    await file.slice(0, READ_HEADER_BYTES).arrayBuffer(),
  );
  const headView = new DataView(head.buffer);
  const declared =
    readPngSize(head, headView) ??
    readJpegSize(head, headView) ??
    readWebpSize(head, headView);
  if (declared) {
    return declared;
  }
  if (
    head[0] !== JPEG_START_OF_IMAGE[0] ||
    head[1] !== JPEG_START_OF_IMAGE[1]
  ) {
    return null;
  }
  const scan = new Uint8Array(
    await file.slice(0, MAX_HEADER_SCAN_BYTES).arrayBuffer(),
  );
  return readJpegSize(scan, new DataView(scan.buffer));
};
