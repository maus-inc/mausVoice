import { openUrl } from "@tauri-apps/plugin-opener";
import { getLogger } from "./log.utils";

/**
 * Open a URL in the person's browser, and keep the failure local.
 *
 * The opener plugin rejects when the operating system has nothing registered
 * for the URL, and the call sites are click handlers, so a rejected promise
 * there is an unhandled rejection with nothing to catch it. Every caller wants
 * the same two things: the failure logged, and the app left exactly where it
 * was, because a row that cannot open a page must not act as though it did.
 *
 * URLs opened this way are fixed links the app ships, not user input, so the
 * log line is safe to write.
 */
export const openExternalUrl = (url: string): void => {
  openUrl(url).catch((error: unknown) => {
    getLogger().warning(`Failed to open ${url}: ${error}`);
  });
};
