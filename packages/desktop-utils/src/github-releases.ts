/**
 * Single source of truth for the GitHub coordinates the app talks to.
 *
 * The updater, the release history, and the release pipeline all need these,
 * and none of them can read a config file the others also read. Deriving every
 * URL from one exported pair keeps a repository rename from silently breaking
 * the manual-install fallback, the release history, and the CI manifest in
 * three different ways at once.
 */

/** `owner`/`repo` of the GitHub repository releases are published to. */
export const GITHUB_REPO_OWNER = "maus-inc";
export const GITHUB_REPO_NAME = "mausVoice";

/** `owner/repo`, for human-facing strings and path assertions. */
export const GITHUB_REPO_SLUG = `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;

/** Canonical web base for the repository. */
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`;

/** Where release assets are uploaded, and what the manual-install fallback reads. */
export const GITHUB_RELEASE_DOWNLOAD_BASE = `${GITHUB_REPO_URL}/releases/download`;

/** The releases page a user is sent to when the in-app updater cannot help. */
export const GITHUB_RELEASES_PAGE_URL = `${GITHUB_REPO_URL}/releases`;

/** Public releases page URL for one tag. */
export const githubReleasePageUrl = (tag: string): string =>
  `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tag)}`;

/**
 * Releases API for the in-app history.
 *
 * This is the unauthenticated endpoint, so it is subject to GitHub's per-IP
 * rate limit. Callers must surface a rate-limit failure as such rather than as
 * a connectivity problem.
 */
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=20`;

/**
 * Tag of the rolling release that carries only `latest-beta.json`.
 *
 * The app must skip it when building history: it is a manifest carrier, not a
 * version a user can install.
 */
export const BETA_CHANNEL_TAG = "beta-channel";
