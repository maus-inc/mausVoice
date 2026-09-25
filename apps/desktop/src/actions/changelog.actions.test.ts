import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => vi.unstubAllGlobals());

describe("fetchChangelog", () => {
  it("excludes the rolling beta artifact without hiding versioned beta releases", async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        row({
          tag_name: "beta-channel",
          name: "Beta channel",
          prerelease: true,
        }),
        row({
          tag_name: "mausVoice-v0.2.0-beta.1",
          name: "0.2.0-beta.1",
          prerelease: true,
        }),
        row(),
      ]),
    );
    const entries = await fetchChangelog();
    expect(entries.map((entry) => entry.tag)).toEqual([
      "mausVoice-v0.2.0-beta.1",
      "mausVoice-v0.1.7",
    ]);
    expect(entries[0].prerelease).toBe(true);
  });
  it("normalizes release rows and strips the tag prefix", async () => {
    fetchMock.mockResolvedValue(okResponse([row()]));

    const entries = await fetchChangelog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/maus-inc/mausVoice/releases?per_page=20",
      expect.any(Object),
    );
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

  it("returns the HTTP status as structured error data", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    await expect(fetchChangelog()).rejects.toMatchObject({
      code: "http",
      status: 403,
    });
  });

  it("throws on a non-list payload", async () => {
    fetchMock.mockResolvedValue(okResponse({ hello: "world" }));

    await expect(fetchChangelog()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("classifies invalid JSON as an invalid response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad JSON");
      },
    });
    await expect(fetchChangelog()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("preserves aborts while reading the response body", async () => {
    const error = new DOMException("aborted", "AbortError");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw error;
      },
    });
    await expect(fetchChangelog()).rejects.toBe(error);
  });

  it("rethrows aborts untouched for the caller to swallow", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValue(abortError);

    await expect(fetchChangelog(controller.signal)).rejects.toBe(abortError);
  });

  it("classifies network failures without exposing raw plugin messages", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    await expect(fetchChangelog()).rejects.toMatchObject({ code: "network" });
  });
});

it.each([
  ["request", true],
  ["body", true],
  ["request", false],
  ["body", false],
] as const)(
  "preserves Error AbortError at %s with DOMException available=%s",
  async (phase, hasDomException) => {
    const error = Object.assign(new Error("canceled"), { name: "AbortError" });
    if (!hasDomException) vi.stubGlobal("DOMException", undefined);
    if (phase === "request") fetchMock.mockRejectedValueOnce(error);
    else
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw error;
        },
      });
    await expect(fetchChangelog()).rejects.toBe(error);
  },
);
it("preserves cross-realm abort-shaped objects", async () => {
  const error = { name: "AbortError", message: "canceled" };
  fetchMock.mockRejectedValueOnce(error);
  await expect(fetchChangelog()).rejects.toBe(error);
});
