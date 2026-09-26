import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  attachConsole: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-log", () => nativeLog);

beforeEach(() => {
  for (const mock of Object.values(nativeLog))
    mock.mockReset().mockResolvedValue(undefined);
});
import { getLogger } from "./log.utils";

const logged = (): string => nativeLog.info.mock.calls[0][0];

describe("object arguments are masked before they reach the log sink", () => {
  it("masks a sensitive key", () => {
    getLogger().info("config", { name: "local", password: "hunter2" });
    expect(nativeLog.info).toHaveBeenCalledTimes(1);
    expect(logged()).toBe('config {"name":"local","password":"[redacted]"}');
  });

  it("masks a sensitive key nested in an object and in an array", () => {
    getLogger().info("payload", {
      provider: { name: "groq", apiKey: "opaque-credential" },
      sessions: [{ token: "opaque" }, { note: "kept" }],
    });
    expect(logged()).toBe(
      'payload {"provider":{"name":"groq","apiKey":"[redacted]"},' +
        '"sessions":[{"token":"[redacted]"},{"note":"kept"}]}',
    );
  });

  it("keeps the log line and falls back to the raw value when the masker faults", () => {
    // The first read is the serialization gate, the second is the masker, and
    // the third is the fallback serialization, so only the masker faults.
    let reads = 0;
    const flaky = {
      label: "visible",
      get token() {
        reads += 1;
        if (reads === 2) throw new Error("masker cannot read this key");
        return "opaque";
      },
    };
    expect(() => getLogger().info("flaky", flaky)).not.toThrow();
    expect(logged()).toBe('flaky {"label":"visible","token":"opaque"}');
  });

  it("passes a non-sensitive object through unchanged", () => {
    getLogger().info("stats", { count: 42, active: true, label: "alpha" });
    expect(logged()).toBe('stats {"count":42,"active":true,"label":"alpha"}');
  });

  it("masks an author key because the auth pattern is unanchored", () => {
    // The alternation matches "auth" inside "author", so an author field is
    // over-redacted. That is the safe direction for a redaction control.
    getLogger().info("commit", { author: "Soniya", file: "notes.md" });
    expect(logged()).toBe('commit {"author":"[redacted]","file":"notes.md"}');
  });

  it("rejects a circular object at the pre-existing serialization gate", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    getLogger().info(circular);
    expect(logged()).toBe("[object Object]");
  });
});
