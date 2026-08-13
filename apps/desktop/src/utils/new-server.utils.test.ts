import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./auth.utils", () => ({
  getEffectiveAuth: vi.fn(),
}));

let DEFAULT_NEW_SERVER_URL: string;
let resolveNewServerUrl: (configuredUrl: string | undefined) => string;
let buildNewServerWebSocketUrl: (baseUrl: string, endpoint: string) => string;

beforeAll(async () => {
  const module = await import("./new-server.utils");
  DEFAULT_NEW_SERVER_URL = module.DEFAULT_NEW_SERVER_URL;
  resolveNewServerUrl = module.resolveNewServerUrl;
  buildNewServerWebSocketUrl = module.buildNewServerWebSocketUrl;
});

describe("resolveNewServerUrl", () => {
  it("uses the production API when no build-time URL is configured", () => {
    expect(resolveNewServerUrl(undefined)).toBe("https://api.mausvoice.com");
    expect(DEFAULT_NEW_SERVER_URL).toBe("https://api.mausvoice.com");
  });

  it("preserves explicit development and enterprise endpoints", () => {
    expect(resolveNewServerUrl("https://api-dev.mausvoice.com")).toBe(
      "https://api-dev.mausvoice.com",
    );
    expect(resolveNewServerUrl("http://localhost:6325")).toBe(
      "http://localhost:6325",
    );
  });

  it("normalizes whitespace and trailing slashes without losing a path", () => {
    expect(resolveNewServerUrl("  https://example.test/base///  ")).toBe(
      "https://example.test/base",
    );
  });

  it("falls back for blank, malformed, unsupported, and credentialed URLs", () => {
    expect(resolveNewServerUrl("   ")).toBe("https://api.mausvoice.com");
    expect(resolveNewServerUrl("not a URL")).toBe("https://api.mausvoice.com");
    expect(resolveNewServerUrl("ftp://example.test")).toBe(
      "https://api.mausvoice.com",
    );
    expect(resolveNewServerUrl("https://user:pass@example.test")).toBe(
      "https://api.mausvoice.com",
    );
  });
});

describe("buildNewServerWebSocketUrl", () => {
  it("maps HTTP(S) to WS(S), joins paths once, and drops query fragments", () => {
    expect(
      buildNewServerWebSocketUrl(
        "https://example.test/base///?ignored=true#ignored",
        "/v1/dictation",
      ),
    ).toBe("wss://example.test/base/v1/dictation");
    expect(
      buildNewServerWebSocketUrl("http://localhost:6325/", "v1/transcribe-raw"),
    ).toBe("ws://localhost:6325/v1/transcribe-raw");
  });
});
