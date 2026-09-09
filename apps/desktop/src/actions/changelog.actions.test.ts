import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

import { fetchChangelog } from "./changelog.actions";

const row = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "mausVoice-v0.1.7",
  name: "mausVoice v0.1.7",
  published_at: "2026-09-01T12:00:00Z",
  body: "Fixes.",
  prerelease: false,
  html_url:
    "https://github.com/maus-inc/mausVoice/releases/tag/mausVoice-v0.1.7",
  ...overrides,
});

const okResponse = (json: unknown) => ({
  ok: true,
  status: 200,
  json: async () => json,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchChangelog", () => {
  it("normalizes release rows and strips the tag prefix", async () => {
    fetchMock.mockResolvedValue(okResponse([row()]));

    const entries = await fetchChangelog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([
      {
        version: "0.1.7",
        tag: "mausVoice-v0.1.7",
        date: "2026-09-01T12:00:00Z",
        body: "Fixes.",
        prerelease: false,
        url: "https://github.com/maus-inc/mausVoice/releases/tag/mausVoice-v0.1.7",
      },
    ]);
  });

  it("marks prereleases and falls back to the tag for links", async () => {
    fetchMock.mockResolvedValue(
      okResponse([row({ prerelease: true, html_url: null, name: null })]),
    );

    const [entry] = await fetchChangelog();

    expect(entry?.prerelease).toBe(true);
    expect(entry?.version).toBe("0.1.7");
    expect(entry?.url).toContain("/releases/tag/mausVoice-v0.1.7");
  });

  it("skips malformed rows instead of failing the list", async () => {
    fetchMock.mockResolvedValue(okResponse([null, { nope: true }, row(), 42]));

    const entries = await fetchChangelog();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tag).toBe("mausVoice-v0.1.7");
  });

  it("throws a readable error on HTTP failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    await expect(fetchChangelog()).rejects.toThrow("403");
  });

  it("throws on a non-list payload", async () => {
    fetchMock.mockResolvedValue(okResponse({ hello: "world" }));

    await expect(fetchChangelog()).rejects.toThrow("unexpected shape");
  });

  it("rethrows aborts untouched for the caller to swallow", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValue(abortError);

    await expect(fetchChangelog(controller.signal)).rejects.toBe(abortError);
  });

  it("wraps network failures with context", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    await expect(fetchChangelog()).rejects.toThrow(
      "Could not reach the release history",
    );
  });
});
