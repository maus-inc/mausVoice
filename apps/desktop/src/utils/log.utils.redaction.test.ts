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

  it("passes an author key through now that the auth pattern is anchored", () => {
    // This used to be masked, because the auth alternation matched "auth"
    // inside "author" and so matched every key containing those four letters.
    // It is now anchored, so an incidental word is visible and a real
    // credential is not. The credential half is pinned in
    // redaction.utils.test.ts, which enumerates both sides of that trade.
    getLogger().info("commit", { author: "Soniya", file: "notes.md" });
    expect(logged()).toBe('commit {"author":"Soniya","file":"notes.md"}');
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

describe("a top level array is masked like a top level record", () => {
  it("masks a sensitive key in an element", () => {
    getLogger().info("rows", [{ name: "a", apiKey: "opaque" }, { name: "b" }]);
    expect(logged()).toBe(
      'rows [{"name":"a","apiKey":"[redacted]"},{"name":"b"}]',
    );
  });

  it("masks a sensitive key nested in an object inside an element", () => {
    getLogger().info("events", [
      { label: "turn", detail: { provider: { password: "opaque" } } },
    ]);
    expect(logged()).toBe(
      'events [{"label":"turn","detail":{"provider":{"password":"[redacted]"}}}]',
    );
  });

  it("renders a top level array as a JSON array with no sensitive key", () => {
    getLogger().info("labels", ["alpha", { count: 2, active: true }, null]);
    expect(logged()).toBe('labels ["alpha",{"count":2,"active":true},null]');
  });

  it("keeps a sensitive key that renders itself redacted", () => {
    getLogger().info("cfg", [{ password: { toJSON: () => "hunter2" } }]);
    expect(logged()).toBe('cfg [{"password":"[redacted]"}]');
  });

  it("resolves a top level array that renders itself and redacts it", () => {
    const rows = Object.assign([{ note: "kept" }], {
      toJSON: () => ({ apiKey: "opaque" }),
    });
    getLogger().info("rows", rows);
    expect(logged()).toBe('rows {"apiKey":"[redacted]"}');
  });

  it("keeps the log line and withholds a hostile element", () => {
    // The first read is the serialization gate and the second is the masker,
    // so only the masker faults, which is the only path that walks the array.
    let reads = 0;
    const hostile = {
      label: "visible",
      get token() {
        reads += 1;
        if (reads === 2) throw new Error("masker cannot read this key");
        return "opaque";
      },
    };
    expect(() =>
      getLogger().info("rows", [{ note: "kept" }, hostile]),
    ).not.toThrow();
    expect(nativeLog.info).toHaveBeenCalledTimes(1);
    expect(logged()).toBe("rows [redaction-failed]");
    expect(logged()).not.toContain("opaque");
  });
});
