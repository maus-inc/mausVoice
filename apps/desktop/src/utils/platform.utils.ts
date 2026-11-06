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
