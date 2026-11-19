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
 * The log line names what was being opened, never the URL, and it does not
 * carry the rejection either. Not every call site opens a link the app ships:
 * the changelog and the release notes carry URLs that arrive from GitHub, and
 * an update dialog carries whichever installer URL the update server returned.
 * A URL is not a safe thing to write to a log — query strings are where
 * credentials travel — and the opener's own rejection text quotes the URL back,
 * which puts it in the log by the side door. Interpolating that error into the
 * message would also hand the sink a plain string, and the sink only scrubs
 * text it receives as an `Error`. The description is what tells whoever reads
 * the log which control failed, and it is the one part that cannot be remote.
 */
export const openExternalUrl = (url: string, description: string): void => {
  openUrl(url).catch(() => {
    getLogger().warning(`Failed to open ${description}`);
  });
};
