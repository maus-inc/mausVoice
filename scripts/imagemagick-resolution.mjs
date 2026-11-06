import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Directories trusted to provide the ImageMagick binary, in priority order.
 *
 * Resolving the executable ourselves — rather than letting the OS search
 * `$PATH` — means a writable or attacker-controlled directory earlier in
 * `$PATH` cannot substitute its own `convert`. Callers can still point at a
 * specific binary with `IMAGEMAGICK_CONVERT`, which is validated below.
 */
const TRUSTED_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
];

/**
 * Locate ImageMagick without trusting `$PATH` ordering.
 *
 * Order: an explicit `IMAGEMAGICK_CONVERT` override, then the trusted
 * directories above. Both ImageMagick 7 (`magick`) and 6 (`convert`) are
 * accepted.
 */
export function resolveConvertBinary(
  value = process.env.IMAGEMAGICK_CONVERT,
  trustedDirs = TRUSTED_BIN_DIRS,
) {
  const override = value?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `IMAGEMAGICK_CONVERT must be an absolute path, got: ${override}`,
      );
    }
    if (!existsSync(override) || !statSync(override).isFile()) {
      throw new Error(
        `IMAGEMAGICK_CONVERT does not point at a file: ${override}`,
      );
    }
    return override;
  }

  // Use the fixed search list instead of consulting the process PATH.
  for (const dir of trustedDirs) {
    for (const name of ["magick", "convert"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  throw new Error(
    "ImageMagick was not found in a trusted location.\n" +
      `Searched: ${trustedDirs.join(delimiter)}\n` +
      "Install it, or set IMAGEMAGICK_CONVERT to an absolute path:\n" +
      "  macOS:  brew install imagemagick\n" +
      "  Ubuntu: sudo apt-get install imagemagick",
  );
}
