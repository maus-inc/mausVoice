import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./auth.utils", () => ({
  getEffectiveAuth: vi.fn(),
}));

let DEFAULT_NEW_SERVER_URL: string;
let resolveNewServerUrl: (configuredUrl: string | undefined) => string;

beforeAll(async () => {
  const module = await import("./new-server.utils");
  DEFAULT_NEW_SERVER_URL = module.DEFAULT_NEW_SERVER_URL;
  resolveNewServerUrl = module.resolveNewServerUrl;
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

  it("falls back when configuration is blank", () => {
    expect(resolveNewServerUrl("   ")).toBe("https://api.mausvoice.com");
  });
});
