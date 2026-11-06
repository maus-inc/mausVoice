import { describe, expect, it } from "vitest";
import { resolveServiceUrl } from "./service-url.utils";

describe("resolveServiceUrl", () => {
  it("keeps the configured base path", () => {
    expect(resolveServiceUrl("https://api.example.com/v1/", "chat")).toBe(
      "https://api.example.com/v1/chat",
    );
  });

  it("replaces a base path when the route is absolute", () => {
    expect(resolveServiceUrl("https://api.example.com/v1/", "/health")).toBe(
      "https://api.example.com/health",
    );
  });

  it("resolves a relative base against the route's own origin", () => {
    expect(resolveServiceUrl("http://localhost:8080", "models")).toBe(
      "http://localhost:8080/models",
    );
  });

  it("throws a fixed message instead of echoing a malformed base URL", () => {
    // The URL constructor's error can carry the offending string, so the
    // helper replaces it rather than letting it reach a log or a toast.
    let message = "";
    try {
      resolveServiceUrl("not a url", "chat");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Invalid service base URL");
    expect(message).not.toContain("not a url");
  });

  it("rejects an empty base URL", () => {
    expect(() => resolveServiceUrl("", "chat")).toThrow(TypeError);
  });
});
