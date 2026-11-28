import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellChildProcess } from "../utils/tauri-shell.utils";
import type { SidecarRuntime } from "./base.sidecar";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/tauri-shell.utils", () => ({
  spawnShellSidecar: spawnMock,
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

const { BaseSidecar } = await import("./base.sidecar");

type SpawnInput = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onClose?: (payload: { code: number | null; signal: number | null }) => void;
  onError?: (error: string) => void;
};

class TestSidecar extends BaseSidecar {
  errors: string[] = [];

  constructor() {
    super({
      binaryName: "binaries/test-sidecar",
      host: "127.0.0.1",
      startupTimeoutMs: 1_000,
      healthTimeoutMs: 100,
      healthPollIntervalMs: 10,
      logPrefix: "test-sidecar",
    });
  }

  protected buildSpawnEnv(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  protected parsePortFromLine(line: string): number | null {
    return line.startsWith("PORT=") ? Number(line.slice("PORT=".length)) : null;
  }

  protected handleStdoutLine(): void {}

  protected onStarted(_runtime: SidecarRuntime): void {}

  protected onStopped(): void {}

  protected onError(message: string): void {
    this.errors.push(message);
  }

  protected checkHealthResponse(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const captureSpawn = (): SpawnInput => {
  const input: SpawnInput = {};
  spawnMock.mockImplementationOnce(async (spawnInput: SpawnInput) => {
    Object.assign(input, spawnInput);
    return {
      pid: 4242,
      write: async () => {},
      kill: async () => {},
    } satisfies ShellChildProcess;
  });

  return input;
};

describe("BaseSidecar exit diagnostics", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("quotes the last sidecar stderr line when startup fails", async () => {
    const sidecar = new TestSidecar();
    const spawn = captureSpawn();

    const started = sidecar.ensureStarted();
    started.catch(() => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    spawn.onStderr?.(
      "\u001b[2m2026-11-28T08:00:00Z\u001b[0m \u001b[33m WARN\u001b[0m loading model\n",
    );
    spawn.onStderr?.(
      "\u001b[2m2026-11-28T08:00:01Z\u001b[0m \u001b[31mERROR\u001b[0m weights are corrupt\n",
    );
    spawn.onClose?.({ code: 1, signal: null });

    const expected =
      "Sidecar exited (code=1, signal=unknown): 2026-11-28T08:00:01Z ERROR weights are corrupt";
    await expect(started).rejects.toThrow(expected);
    expect(sidecar.errors.length).toBeGreaterThan(0);
    expect(sidecar.errors.every((message) => message === expected)).toBe(true);
  });

  it("keeps the exit message unchanged when the sidecar said nothing", async () => {
    const sidecar = new TestSidecar();
    const spawn = captureSpawn();

    const started = sidecar.ensureStarted();
    started.catch(() => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    spawn.onClose?.({ code: null, signal: 4 });

    await expect(started).rejects.toThrow(
      "Sidecar exited (code=unknown, signal=4)",
    );
    expect(
      sidecar.errors.every(
        (message) => message === "Sidecar exited (code=unknown, signal=4)",
      ),
    ).toBe(true);
  });

  it("bounds the quoted detail so a long diagnostic cannot flood the message", async () => {
    const sidecar = new TestSidecar();
    const spawn = captureSpawn();

    const started = sidecar.ensureStarted();
    started.catch(() => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    spawn.onStderr?.(`failure: ${"x".repeat(500)}\n`);
    spawn.onClose?.({ code: 1, signal: null });

    await expect(started).rejects.toThrow(
      /^Sidecar exited \(code=1, signal=unknown\): failure: x{191}$/,
    );
  });
});
