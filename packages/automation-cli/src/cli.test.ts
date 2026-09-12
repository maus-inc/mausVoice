import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, AutomationApiError } from "./client";
import { run } from "./cli";

const conn = { baseUrl: "http://127.0.0.1:37291", token: "t" };

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe("apiGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and returns parsed JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await apiGet(conn, "/api/v1/status")).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:37291/api/v1/status",
      { headers: { Authorization: "Bearer t" } },
    );
  });

  it("throws a status error on API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, 404)),
    );
    const error = await apiGet(conn, "/x").catch((e) => e);
    expect(error).toBeInstanceOf(AutomationApiError);
    expect((error as AutomationApiError).status).toBe(404);
  });

  it("throws a connection error when unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );
    await expect(apiGet(conn, "/api/v1/status")).rejects.toThrow(
      /is the mausVoice desktop app running/,
    );
  });
});

describe("run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unknown commands", async () => {
    await expect(run(["--token", "t", "bogus"])).resolves.toBe(1);
  });

  it("requires a query for search", async () => {
    await expect(run(["--token", "t", "search"])).resolves.toBe(1);
  });

  it("fetches status end to end", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      run(["--token", "t", "--port", "37291", "status"]),
    ).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:37291/api/v1/status",
      expect.anything(),
    );
  });
});
