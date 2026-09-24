import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
afterEach(() => vi.unstubAllGlobals());
import { getLogger, initLogging, redactQueryParamValues } from "./log.utils";

describe("redactQueryParamValues", () => {
  it("redacts every occurrence of the named parameters", () => {
    expect(
      redactQueryParamValues(
        "wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=Soniya&keyterm=Kubernetes",
        ["keyterm"],
      ),
    ).toBe(
      "wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=***&keyterm=***",
    );
  });

  it("redacts auth tokens and keyterms together", () => {
    expect(
      redactQueryParamValues(
        "wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=secret&keyterms=Soniya",
        ["token", "keyterms"],
      ),
    ).toBe(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=***&keyterms=***",
    );
  });

  it("returns the input unchanged when it is not a parseable URL", () => {
    expect(redactQueryParamValues("not a url", ["keyterm"])).toBe("not a url");
  });
});

describe("best-effort native logging", () => {
  it.each(["info", "warning", "error", "verbose"] as const)(
    "owns the native rejection for %s",
    async (level) => {
      const rejected = Promise.reject(new Error("native log unavailable"));
      const consume = vi.spyOn(rejected, "catch");
      for (const mock of Object.values(nativeLog))
        mock.mockReturnValue(rejected);
      try {
        expect(() => getLogger()[level]("operation failed")).not.toThrow();
        // Mock spies themselves may track/consume rejected promises. Verify that
        // the production boundary also installs its own rejection handler.
        expect(consume).toHaveBeenCalledTimes(1);
      } finally {
        await rejected.catch(() => undefined);
      }
    },
  );

  it("does not let a synchronous logger or hostile argument break the caller", () => {
    nativeLog.error.mockImplementation(() => {
      throw new Error("sink error");
    });
    expect(() => getLogger().error("safe label")).not.toThrow();
    const hostile = {
      toJSON() {
        throw new Error("cannot serialize");
      },
      toString() {
        throw new Error("cannot stringify");
      },
    };
    expect(() => getLogger().info(hostile)).not.toThrow();
    expect(nativeLog.info).not.toHaveBeenCalled();
  });

  it("keeps stopwatch success and the original operation rejection intact", async () => {
    nativeLog.info.mockRejectedValue(new Error("sink unavailable"));
    nativeLog.error.mockRejectedValue(new Error("sink unavailable"));
    await expect(getLogger().stopwatch("work", async () => 42)).resolves.toBe(
      42,
    );
    const failure = new Error("original operation failure");
    await expect(
      getLogger().stopwatch("work", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("uses the same rejection containment for global error handlers", async () => {
    vi.stubGlobal("window", {});
    await initLogging();
    nativeLog.error.mockRejectedValue(new Error("sink unavailable"));
    window.onerror?.call(
      window,
      "error",
      "app",
      1,
      2,
      new Error("operation error"),
    );
    window.onunhandledrejection?.call(window, {
      reason: "operation failure",
    } as PromiseRejectionEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativeLog.error).toHaveBeenCalledTimes(2);
  });
});
