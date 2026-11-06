import { platform } from "@tauri-apps/plugin-os";

export type Platform = "macos" | "windows" | "linux" | "unknown";

let cachedPlatform: Platform | null = null;

export const getPlatform = (): Platform => {
  if (cachedPlatform) {
    return cachedPlatform;
  }

  const platformName = platform();
  switch (platformName) {
    case "macos":
      cachedPlatform = "macos";
      break;
    case "windows":
      cachedPlatform = "windows";
      break;
    case "linux":
      cachedPlatform = "linux";
      break;
    default:
      cachedPlatform = "unknown";
      break;
  }

  return cachedPlatform;
};

/**
 * Mirrors `ALLOWED_COMMANDS` in `src-tauri/src/commands.rs`. Commands run
 * without a shell, so Windows exposes only real executables (CMD builtins
 * like `dir`/`cd` have no binary to spawn). Keep both lists in sync.
 */
export const getAllowedTerminalBinaries = (): string[] => {
  switch (getPlatform()) {
    case "windows":
      return ["whoami", "where", "hostname", "explorer"];
    case "macos":
      return [...UNIX_TERMINAL_BINARIES, "open"];
    default:
      return [...UNIX_TERMINAL_BINARIES, "xdg-open"];
  }
};

const UNIX_TERMINAL_BINARIES = [
  "ls",
  "pwd",
  "echo",
  "cat",
  "which",
  "whoami",
  "date",
  "uname",
  "df",
  "du",
  "head",
  "tail",
  "wc",
];

type CursorToViewportParams = {
  cursorX: number;
  cursorY: number;
  visibleX: number;
  visibleY: number;
  visibleHeight: number;
  scaleFactor?: number;
};

export const cursorToViewportPosition = (
  params: CursorToViewportParams,
): { x: number; y: number } => {
  const {
    cursorX,
    cursorY,
    visibleX,
    visibleY,
    visibleHeight,
    scaleFactor = 1,
  } = params;
  const plt = getPlatform();

  if (plt === "macos") {
    const x = Math.round(cursorX - visibleX);
    const y = Math.round(visibleHeight - (cursorY - visibleY));
    return { x, y };
  } else {
    // Windows/Linux: coordinates are in physical pixels, convert to CSS pixels
    const x = Math.round((cursorX - visibleX) / scaleFactor);
    const y = Math.round((cursorY - visibleY) / scaleFactor);
    return { x, y };
  }
};

export const getOverlayBottomOffset = (): number => {
  const plt = getPlatform();
  switch (plt) {
    case "macos":
      return 12;
    case "linux":
      return 8;
    case "windows":
      return 8;
    default:
      return 12;
  }
};
