import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("./secure-fetch.utils", () => ({ secureFetch: fetchMock }));

import { ollamaTestIntegration } from "./ollama.utils";

describe("Ollama integration diagnostics", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("does not disclose configured URL or transport details on connection failure", async () => {
    fetchMock.mockRejectedValue(new Error("network failed: transport-secret"));
    const error = await ollamaTestIntegration({
      baseUrl: "https://user:url-secret@example.com/?token=query-secret",
      apiKey: "bearer-secret",
    }).catch((reason: unknown) => reason);
    expect(String(error)).toContain("Unable to connect to Ollama");
    expect(String(error)).not.toMatch(
      /url-secret|query-secret|bearer-secret|transport-secret/,
    );
  });

  it("still sends the configured URL and bearer header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(
      ollamaTestIntegration({
        baseUrl: "http://localhost:11434",
        apiKey: "key",
      }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434", {
      headers: { Authorization: "Bearer key" },
    });
  });

  it.each([200, 401, 500])(
    "discards an unused integration response body for HTTP %i",
    async (status) => {
      const response = new Response("private response", { status });
      const cancel = vi
        .spyOn(response.body!, "cancel")
        .mockReturnValue(new Promise(() => {}));
      fetchMock.mockResolvedValue(response);
      const outcome = ollamaTestIntegration({ apiKey: "key" }).catch(
        (error: unknown) => error,
      );
      const result = await Promise.race([
        outcome,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("stalled"), 100),
        ),
      ]);
      expect(result).not.toBe("stalled");
      if (status === 200) expect(result).toBe(true);
      else expect(result).toBeInstanceOf(Error);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("reports authorization failures without exposing credentials", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(ollamaTestIntegration({ apiKey: "key" })).rejects.toThrow(
      "Ollama authentication failed",
    );
  });
});
