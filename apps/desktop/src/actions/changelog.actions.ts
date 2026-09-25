import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type ChangelogEntry = {
  version: string;
  tag: string;
  date: string | null;
  body: string;
  prerelease: boolean;
  url: string;
};

type ChangelogErrorCode = "network" | "http" | "invalid-response";

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

const RELEASES_URL =
  "https://api.github.com/repos/maus-inc/mausVoice/releases?per_page=20";

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
  if (!tag || tag === "beta-channel") {
    return null;
  }
  return {
    version: displayVersion(tag, asString(row.name)),
    tag,
    date: asString(row.published_at),
    body: asString(row.body) ?? "",
    prerelease: row.prerelease === true,
    url:
      asString(row.html_url) ??
      `https://github.com/maus-inc/mausVoice/releases/tag/${tag}`,
  };
};

// Native HTTP, polyfills and cross-realm errors need not share a constructor.
const isAbortError = (error: unknown): boolean =>
  isRecord(error) && error.name === "AbortError";

const fetchReleasesJson = async (signal?: AbortSignal): Promise<unknown> => {
  let response: Response;
  try {
    response = await tauriFetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    throw new ChangelogFetchError("network");
  }
  if (!response.ok) {
    throw new ChangelogFetchError("http", response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
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
