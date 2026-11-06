const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read an ICO directory only after checking that entries and payloads fit. */
export function parseIcoFrames(data, path) {
  if (
    data.length < 6 ||
    data.readUInt16LE(0) !== 0 ||
    data.readUInt16LE(2) !== 1
  ) {
    throw new Error(`${path} is not a valid ICO file`);
  }
  const count = data.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > data.length) {
    throw new Error(`${path}: truncated ICO directory`);
  }
  return Array.from({ length: count }, (_, i) => {
    const entry = 6 + i * 16;
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    if (
      offset < directoryEnd ||
      length === 0 ||
      offset > data.length ||
      length > data.length - offset
    ) {
      throw new Error(`${path}: frame ${i} has an invalid payload range`);
    }
    return {
      width: data[entry] === 0 ? 256 : data[entry],
      height: data[entry + 1] === 0 ? 256 : data[entry + 1],
      bpp: data.readUInt16LE(entry + 6),
    };
  });
}

/** Width/height from a PNG's first IHDR, or nulls for a non-PNG payload. */
function readPngSize(payload) {
  const isPng =
    payload.length >= 33 &&
    payload.subarray(0, 8).equals(PNG_MAGIC) &&
    payload.readUInt32BE(8) === 13 &&
    payload.toString("ascii", 12, 16) === "IHDR";
  return isPng
    ? { width: payload.readUInt32BE(16), height: payload.readUInt32BE(20) }
    : { width: null, height: null };
}

function validateIcnsHeader(data, path) {
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "icns") {
    throw new Error(
      `${path} is not an ICNS container (a renamed PNG will not do)`,
    );
  }
  const declared = data.readUInt32BE(4);
  if (declared !== data.length) {
    throw new Error(
      `${path}: header declares ${declared} bytes but the file is ${data.length}`,
    );
  }
}

/** Walk a validated ICNS container and decode its frame sizes. */
export function parseIcnsFrames(data, path) {
  validateIcnsHeader(data, path);
  const frames = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || length > data.length - offset) {
      throw new Error(`${path}: chunk '${type}' declares an invalid length`);
    }
    frames.push({
      type,
      ...readPngSize(data.subarray(offset + 8, offset + length)),
    });
    offset += length;
  }
  if (offset !== data.length) {
    throw new Error(
      `${path}: ${data.length - offset} trailing byte(s) after the last chunk`,
    );
  }
  return frames;
}

/** Every required frame size is present, at 32bpp. */
export function checkIcoFrameSizes(ico, frames, sizes) {
  const problems = [];

  for (const size of sizes) {
    if (
      !frames.some((frame) => frame.width === size && frame.height === size)
    ) {
      problems.push(`${ico}: missing a ${size}x${size} frame`);
    }
  }
  for (const frame of frames) {
    if (frame.bpp !== 32) {
      problems.push(
        `${ico}: frame ${frame.width}x${frame.height} is ${frame.bpp}bpp, need 32bpp for alpha`,
      );
    }
  }
  return problems;
}

/** Check each required ICNS chunk and its advertised dimensions. */
export function checkIcnsFrameSizes(icns, frames, required) {
  const problems = [];
  for (const { type, size } of required) {
    const frame = frames.find((candidate) => candidate.type === type);
    if (!frame) {
      problems.push(`${icns}: missing the ${size}x${size} '${type}' frame`);
      continue;
    }
    if (frame.width !== size || frame.height !== size) {
      problems.push(
        `${icns}: '${type}' frame is ${frame.width}x${frame.height}, expected ${size}x${size}`,
      );
    }
  }
  return problems;
}

/** Reject failed or malformed ImageMagick probes instead of accepting them as transparent. */
export function parseCornerAlpha(output, imageSpec) {
  const text = output.trim();
  const alpha = Number(text);
  if (!text || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error(
      `${imageSpec}: invalid corner alpha returned by ImageMagick`,
    );
  }
  return alpha;
}
