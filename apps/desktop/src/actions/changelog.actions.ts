import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  BETA_CHANNEL_TAG,
  GITHUB_RELEASES_API_URL,
  githubReleasePageUrl,
} from "@maus-inc/desktop-utils";

export type ChangelogEntry = {
  version: string;
  tag: string;
  date: string | null;
  body: string;
  prerelease: boolean;
  url: string;
};

type ChangelogErrorCode =
  "network" | "http" | "rate-limited" | "invalid-response";

export class ChangelogFetchError extends Error {
  readonly code: ChangelogErrorCode;
  readonly status: number | null;

  constructor(code: ChangelogErrorCode, status: number | null = null) {
    super(`changelog:${code}`);
    this.name = "ChangelogFetchError";
    this.code = code;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const displayVersion = (tag: string, name: string | null): string => {
  const clean = (value: string) =>
    value.replace(/^mausvoice[\s\-_]*v?/i, "").trim();
  return clean(name || "") || clean(tag) || tag;
};

/** Map one GitHub release row; null when the row is unusable. */
const toChangelogEntry = (
  row: Record<string, unknown>,
): ChangelogEntry | null => {
  const tag = asString(row.tag_name);
  if (!tag || tag === BETA_CHANNEL_TAG) {
    return null;
  }
  return {
    version: displayVersion(tag, asString(row.name)),
    tag,
    date: asString(row.published_at),
    body: asString(row.body) ?? "",
    prerelease: row.prerelease === true,
    url: asString(row.html_url) ?? githubReleasePageUrl(tag),
  };
};

// Native HTTP, polyfills and cross-realm errors need not share a constructor.
const isAbortError = (error: unknown): boolean =>
  isRecord(error) && error.name === "AbortError";

/**
 * Whether a 403 or 429 from the releases endpoint is actually a rate limit.
 *
 * GitHub answers 403 for several unrelated conditions: a primary or secondary
 * rate limit, an abuse block, a private or renamed repository, a policy block.
 * Only the first is fixed by waiting, so telling every 403 to wait sends the
 * user down the wrong path for the rest. The rate-limit responses carry
 * `x-ratelimit-remaining: 0` or a `retry-after`, which is what separates them.
 */
const isRateLimitResponse = (response: Response): boolean => {
  if (response.headers.get("retry-after")) {
    return true;
  }
  return response.headers.get("x-ratelimit-remaining") === "0";
};

/**
 * Re-throw an abort, and swallow nothing else.
 *
 * Both the request and the body read need this, and the two cases differ only
 * in which typed failure they raise when the failure was *not* an abort.
 */
const rethrowIfAborted = (error: unknown, signal?: AbortSignal): void => {
  if (signal?.aborted || isAbortError(error)) {
    throw error;
  }
};

const fetchReleasesJson = async (signal?: AbortSignal): Promise<unknown> => {
  let response: Response;
  try {
    response = await tauriFetch(GITHUB_RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
  } catch (error) {
    rethrowIfAborted(error, signal);
    throw new ChangelogFetchError("network");
  }
  // The releases endpoint is unauthenticated, so GitHub caps it per IP, and a
  // rate limit on this URL would otherwise read as a failed connection check.
  // Only responses that identify themselves as rate limits get that label.
  if (
    (response.status === 403 || response.status === 429) &&
    isRateLimitResponse(response)
  ) {
    throw new ChangelogFetchError("rate-limited", response.status);
  }
  if (!response.ok) {
    throw new ChangelogFetchError("http", response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    rethrowIfAborted(error, signal);
    throw new ChangelogFetchError("invalid-response");
  }
};

/**
 * Lists recent GitHub releases for the in-app changelog. Rows with an
 * unusable shape are skipped, never thrown: one odd release must not hide
 * the rest of the history.
 */
export const fetchChangelog = async (
  signal?: AbortSignal,
): Promise<ChangelogEntry[]> => {
  const json = await fetchReleasesJson(signal);
  if (!Array.isArray(json)) {
    throw new ChangelogFetchError("invalid-response");
  }

  const entries: ChangelogEntry[] = [];
  for (const row of json) {
    if (!isRecord(row)) {
      continue;
    }
    const entry = toChangelogEntry(row);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= 20) {
      break;
    }
  }
  return entries;
};
