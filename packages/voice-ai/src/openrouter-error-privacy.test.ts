import { describe, expect, it, vi } from "vitest";
import {
  openrouterFetchModels,
  openrouterFetchProviders,
} from "./openrouter.utils";

describe("OpenRouter discovery errors", () => {
  it.each(["models", "providers"] as const)(
    "does not expose the untrusted %s reason phrase",
    async (kind) => {
      const privateValue = "confidential-provider-value";
      const customFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 401,
          statusText: `Failed ${privateValue}`,
        }),
      );
      const request =
        kind === "models"
          ? openrouterFetchModels({ apiKey: privateValue, customFetch })
          : openrouterFetchProviders({ customFetch });
      const error = await request.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("401");
      expect(String(error)).not.toContain(privateValue);
      expect(JSON.stringify(error)).not.toContain(privateValue);
    },
  );

  it.each(["models", "providers"] as const)(
    "does not expose %s transport or JSON-parser errors",
    async (kind) => {
      const privateValue = "sensitive";
      for (const customFetch of [
        vi.fn().mockRejectedValue(new Error(`network ${privateValue}`)),
        vi
          .fn()
          .mockResolvedValue(
            new Response(`${privateValue} transcript`, { status: 200 }),
          ),
      ]) {
        const request =
          kind === "models"
            ? openrouterFetchModels({ apiKey: privateValue, customFetch })
            : openrouterFetchProviders({ customFetch });
        const error = await request.then(
          () => null,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(privateValue);
        expect(JSON.stringify(error)).not.toContain(privateValue);
      }
    },
  );

  it.each(["models", "providers"] as const)(
    "returns %s discovery data and sends credentials only for models",
    async (kind) => {
      const entry = { id: "example" };
      const customFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [entry] }), { status: 200 }),
        );
      const result =
        kind === "models"
          ? await openrouterFetchModels({
              apiKey: "  private-key  ",
              customFetch,
            })
          : await openrouterFetchProviders({ customFetch });
      expect(result).toEqual({ [kind]: [entry] });
      expect(customFetch.mock.calls[0]?.[0]).toBe(
        `https://openrouter.ai/api/v1/${kind}`,
      );
      const headers = customFetch.mock.calls[0]?.[1]?.headers;
      expect(headers.Authorization).toBe(
        kind === "models" ? "Bearer private-key" : undefined,
      );
      expect(headers["HTTP-Referer"]).toBeTruthy();
      expect(headers["X-Title"]).toBeTruthy();
    },
  );
});
