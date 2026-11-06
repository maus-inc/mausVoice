import { readAbortableResponseJson } from "@maus-inc/utilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellChildProcess } from "../utils/tauri-shell.utils";
import { BaseSidecar, type SidecarRuntime } from "./base.sidecar";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../utils/tauri-shell.utils", () => ({
  spawnShellSidecar: mocks.spawn,
}));
vi.mock("../utils/secure-fetch.utils", () => ({ secureFetch: mocks.fetch }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

class TestSidecar extends BaseSidecar {
  readonly errors: string[] = [];
  constructor() {
    super({
      binaryName: "test",
      host: "127.0.0.1",
      startupTimeoutMs: 100,
      healthTimeoutMs: 20,
      healthPollIntervalMs: 5,
      logPrefix: "test",
    });
  }
  protected async buildSpawnEnv() {
    return {};
  }
  protected parsePortFromLine(line: string) {
    return line === "ready" ? 1234 : null;
  }
  protected handleStdoutLine(_line: string, _child: ShellChildProcess) {}
  protected onStarted(_runtime: SidecarRuntime) {}
  protected onStopped() {}
  protected onError(message: string) {
    this.errors.push(message);
  }
  protected async checkHealthResponse(
    _response: Response,
    _signal: AbortSignal,
  ) {
    return true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.fetch.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sidecar startup ownership", () => {
  it("kills the spawned process when port readiness times out", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockResolvedValue(child);
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow(
      "Timed out waiting for test readiness",
    );
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(sidecar.getRuntime()).toBeNull();
  });

  it("reports a pre-readiness process exit only once", async () => {
    let onClose!: (payload: { code: number; signal: null }) => void;
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async (options) => {
      onClose = options.onClose;
      return child;
    });
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar exited");
    await vi.advanceTimersByTimeAsync(0);
    onClose({ code: 1, signal: null });
    await result;
    expect(sidecar.errors).toHaveLength(1);
  });

  it("does not report a second failure when cleanup closes a timed-out child", async () => {
    let onClose!: (payload: { code: number; signal: null }) => void;
    const child = {
      pid: 17,
      kill: vi.fn(async () => {
        onClose({ code: 1, signal: null });
      }),
    };
    mocks.spawn.mockImplementation(async (options) => {
      onClose = options.onClose;
      return child;
    });
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow(
      "Timed out waiting for test readiness",
    );
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(sidecar.errors).toEqual(["Timed out waiting for test readiness"]);
  });

  it("cancels and cleans up a startup when disposed before readiness", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockResolvedValue(child);
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(sidecar.getRuntime()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spawn after disposal while environment setup is pending", async () => {
    let resolveEnv!: (value: Record<string, string>) => void;
    class SlowSidecar extends TestSidecar {
      protected override buildSpawnEnv(): Promise<Record<string, string>> {
        return new Promise((resolve) => {
          resolveEnv = resolve;
        });
      }
    }
    const sidecar = new SlowSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await sidecar.dispose();
    resolveEnv({});
    await result;
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("kills a child that appears after its pending spawn was cancelled", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    let resolveSpawn!: (value: typeof child) => void;
    mocks.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    resolveSpawn(child);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(sidecar.getRuntime()).toBeNull();
  });

  it("allows a fresh startup while a cancelled spawn is still pending", async () => {
    const oldChild = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    const newChild = { pid: 18, kill: vi.fn().mockResolvedValue(undefined) };
    let resolveOld!: (value: typeof oldChild) => void;
    mocks.spawn
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(async ({ onStdout }) => {
        queueMicrotask(() => onStdout("ready\n"));
        return newChild;
      });
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    let rejected = false;
    void startup.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(rejected).toBe(true);
      const replacement = sidecar.ensureStarted();
      await vi.advanceTimersByTimeAsync(0);
      expect((await replacement).child).toBe(newChild);
      resolveOld(oldChild);
      await vi.advanceTimersByTimeAsync(0);
      expect(oldChild.kill).toHaveBeenCalledOnce();
      expect(sidecar.getRuntime()?.child).toBe(newChild);
      await sidecar.dispose();
      expect(newChild.kill).toHaveBeenCalledOnce();
    } finally {
      resolveOld(oldChild);
    }
  });

  it("cancels a pending health probe and permits a subsequent start", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async (options) => {
      queueMicrotask(() => options.onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockImplementation(() => new Promise(() => undefined));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const replacement = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect((await replacement).port).toBe(1234);
    await sidecar.dispose();
  });

  it("kills a child on disposal while its health response body is stalled", async () => {
    class BodyReadingSidecar extends TestSidecar {
      protected override async checkHealthResponse(response: Response) {
        await response.json();
        return true;
      }
    }
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} })),
    );
    const sidecar = new BodyReadingSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    await result;
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(sidecar.getRuntime()).toBeNull();
  });

  it("cancels the health body as well as the child when startup is disposed", async () => {
    class AbortableHealthSidecar extends TestSidecar {
      protected override async checkHealthResponse(
        response: Response,
        signal: AbortSignal,
      ) {
        await readAbortableResponseJson(response, signal);
        return true;
      }
    }
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    const cancel = vi.fn();
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const sidecar = new AbortableHealthSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar startup cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await sidecar.dispose();
    await result;
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("enforces startup deadlines when a health response body stalls", async () => {
    class BodyReadingSidecar extends TestSidecar {
      protected override async checkHealthResponse(response: Response) {
        await response.json();
        return true;
      }
    }
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockImplementation(
      async () => new Response(new ReadableStream({ start() {} })),
    );
    const sidecar = new BodyReadingSidecar();
    const startup = sidecar.ensureStarted();
    let settled = false;
    void startup.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    await expect(startup).rejects.toThrow("Timed out waiting for test health");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(sidecar.getRuntime()).toBeNull();
  });

  it("discards an unread successful health response body", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    const cancel = vi.fn();
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect((await startup).child).toBe(child);
    expect(cancel).toHaveBeenCalledOnce();
    await sidecar.dispose();
  });

  it("discards unsuccessful health response bodies before retrying", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    const cancel = vi.fn();
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), { status: 503 }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(10);
    expect((await startup).child).toBe(child);
    expect(cancel).toHaveBeenCalledOnce();
    await sidecar.dispose();
  });

  it("handles a shell error delivered before spawn resolves and kills the child", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation((options) => {
      options.onError("early failure");
      return new Promise((resolve) => setTimeout(() => resolve(child), 10));
    });
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("early failure");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("stops health polling when the child exits after reporting its port", async () => {
    let onClose!: (payload: { code: number; signal: null }) => void;
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async (options) => {
      onClose = options.onClose;
      queueMicrotask(() => options.onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(new Response("not ready", { status: 503 }));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar exited");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    onClose({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(5);
    await result;
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not publish a child that exits while the health probe is pending", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    let onClose!: (payload: { code: number; signal: null }) => void;
    let resolveHealth!: (response: Response) => void;
    mocks.spawn.mockImplementation(async (options) => {
      onClose = options.onClose;
      queueMicrotask(() => options.onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHealth = resolve;
        }),
    );
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    const result = expect(startup).rejects.toThrow("Sidecar exited");
    await vi.advanceTimersByTimeAsync(0);
    onClose({ code: 1, signal: null });
    resolveHealth(new Response("ok"));
    await result;
    expect(sidecar.getRuntime()).toBeNull();
  });

  it("ignores a delayed close from an intentionally stopped child", async () => {
    let onClose!: (payload: { code: number; signal: null }) => void;
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async (options) => {
      onClose = options.onClose;
      queueMicrotask(() => options.onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    await startup;
    await sidecar.dispose();
    onClose({ code: 0, signal: null });
    expect(sidecar.errors).toEqual([]);
  });

  it("does not confuse a replacement child with a retired child that had the same pid", async () => {
    const callbacks: Array<(payload: { code: number; signal: null }) => void> =
      [];
    mocks.spawn.mockImplementation(async (options) => {
      callbacks.push(options.onClose);
      queueMicrotask(() => options.onStdout("ready\n"));
      return { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    });
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const sidecar = new TestSidecar();
    const first = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    await sidecar.dispose();
    const second = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    callbacks[0]({ code: 0, signal: null });
    expect(sidecar.getRuntime()?.port).toBe(1234);
    callbacks[1]({ code: 1, signal: null });
    expect(sidecar.getRuntime()).toBeNull();
    expect(sidecar.errors).toHaveLength(1);
  });

  it("clears the readiness timer after a successful startup", async () => {
    const child = { pid: 17, kill: vi.fn().mockResolvedValue(undefined) };
    mocks.spawn.mockImplementation(async ({ onStdout }) => {
      queueMicrotask(() => onStdout("ready\n"));
      return child;
    });
    mocks.fetch.mockResolvedValue(new Response("ok"));
    const sidecar = new TestSidecar();
    const startup = sidecar.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    await startup;
    expect(vi.getTimerCount()).toBe(0);
    await sidecar.dispose();
  });
});
