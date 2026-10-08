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
 * The log line names what was being opened, never the URL. Not every call site
 * opens a link the app ships: the changelog and the release notes carry URLs
 * that arrive from GitHub, and an update dialog carries whichever installer URL
 * the update server returned. Those are remote content, and a URL is not a safe
 * thing to write to a log: query strings are where credentials travel, and the
 * redactor's token pattern would pass an ordinary URL through. A description
 * from the caller is a guarantee rather than a hope, and it is what tells
 * whoever reads the log which control failed.
 */
export const openExternalUrl = (url: string, description: string): void => {
  openUrl(url).catch((error: unknown) => {
    getLogger().warning(`Failed to open ${description}: ${error}`);
  });
};
