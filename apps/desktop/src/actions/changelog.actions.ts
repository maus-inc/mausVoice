import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type ChangelogEntry = {
  version: string;
  tag: string;
  date: string | null;
  body: string;
  prerelease: boolean;
  url: string;
};

const RELEASES_URL =
  "https://api.github.com/maus-inc/mausVoice/releases?per_page=20";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const displayVersion = (tag: string, name: string | null): string => {
  const clean = (value: string) =>
    value.replace(/^mausvoice[\s\-_]*v?/i, "").trim();
  return clean(name || "") || clean(tag) || tag;
};

/**
 * Lists recent GitHub releases for the in-app changelog. Rows with an
 * unusable shape are skipped, never thrown: one odd release must not hide
 * the rest of the history.
 */
export const fetchChangelog = async (
  signal?: AbortSignal,
): Promise<ChangelogEntry[]> => {
  let response: Response;
  try {
    response = await tauriFetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(
      `Could not reach the release history: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`The release history returned status ${response.status}.`);
  }

  const json: unknown = await response.json();
  if (!Array.isArray(json)) {
    throw new Error("The release history had an unexpected shape.");
  }

  const entries: ChangelogEntry[] = [];
  for (const row of json) {
    if (!isRecord(row)) {
      continue;
    }
    const tag = asString(row.tag_name);
    if (!tag) {
      continue;
    }
    entries.push({
      version: displayVersion(tag, asString(row.name)),
      tag,
      date: asString(row.published_at),
      body: asString(row.body) ?? "",
      prerelease: row.prerelease === true,
      url:
        asString(row.html_url) ??
        `https://github.com/maus-inc/mausVoice/releases/tag/${tag}`,
    });
    if (entries.length >= 20) {
      break;
    }
  }
  return entries;
};
