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

  it("keeps the log line and withholds the value when the masker faults", () => {
    // The first read is the serialization gate, the second is the masker, and
    // the third would be the fallback serialization, so only the masker faults.
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
    expect(nativeLog.info).toHaveBeenCalledTimes(1);
    expect(logged()).toBe("flaky [redaction-failed]");
    expect(logged()).not.toContain("opaque");
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

  it("keeps the rendered form of an argument that renders itself", () => {
    getLogger().info("at", { startedAt: new Date(0) });
    expect(logged()).toBe('at {"startedAt":"1970-01-01T00:00:00.000Z"}');
  });

  it("keeps the rendered form of a top level argument that renders itself", () => {
    getLogger().info(new Date(0));
    expect(logged()).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it("masks a secret reachable only through toJSON", () => {
    getLogger().info("cfg", {
      config: { toJSON: () => ({ apiKey: "opaque" }) },
    });
    expect(logged()).toBe('cfg {"config":{"apiKey":"[redacted]"}}');
  });
});
