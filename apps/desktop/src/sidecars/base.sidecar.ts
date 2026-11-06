import type { ShellChildProcess } from "../utils/tauri-shell.utils";
import { spawnShellSidecar } from "../utils/tauri-shell.utils";
import { discardResponseBody } from "@maus-inc/utilities";
import { getLogger } from "../utils/log.utils";
import {
  createDeferred,
  fetchWithTimeout,
  raceWithAbort,
  sleep,
  toErrorMessage,
} from "./sidecar.utils";

export type SidecarConfig = {
  binaryName: string;
  host: string;
  startupTimeoutMs: number;
  healthTimeoutMs: number;
  healthPollIntervalMs: number;
  logPrefix: string;
  idleDisposeMs?: number;
};

export type SidecarRuntime = {
  port: number;
  baseUrl: string;
  child: ShellChildProcess;
};

export abstract class BaseSidecar {
  private runtime: SidecarRuntime | null = null;
  private startupPromise: Promise<SidecarRuntime> | null = null;
  private startupController: AbortController | null = null;
  private readonly stoppingChildren = new WeakSet<ShellChildProcess>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activityLeaseCount = 0;

  constructor(protected readonly config: SidecarConfig) {}

  async ensureStarted(): Promise<SidecarRuntime> {
    this.cancelIdleTimer();

    if (this.runtime) {
      return this.runtime;
    }

    if (this.startupPromise) {
      return await this.startupPromise;
    }

    const controller = new AbortController();
    this.startupController = controller;
    // The underlying startup continues far enough to kill a late child, while
    // callers can stop waiting and a successor can start immediately on dispose.
    this.startupPromise = raceWithAbort(
      this.startInternal(controller.signal),
      controller.signal,
    )
      .catch((error) => {
        if (controller.signal.aborted) throw error;
        const message = toErrorMessage(error);
        getLogger().error(
          `[${this.config.logPrefix}] Failed to start: ${message}`,
        );
        this.onError(message);
        throw error;
      })
      .finally(() => {
        if (this.startupController === controller) {
          this.startupController = null;
          this.startupPromise = null;
        }
      });

    return await this.startupPromise;
  }

  async dispose(): Promise<void> {
    this.cancelIdleTimer();
    const controller = this.startupController;
    this.startupController = null;
    this.startupPromise = null;
    controller?.abort(new Error("Sidecar startup cancelled"));
    const runtime = this.runtime;
    this.runtime = null;

    if (!runtime) {
      this.onStopped();
      return;
    }

    this.stoppingChildren.add(runtime.child);
    this.onStopped();

    try {
      await runtime.child.kill();
    } catch (error) {
      getLogger().warning(
        `[${this.config.logPrefix}] Failed to stop pid=${runtime.child.pid}: ${toErrorMessage(error)}`,
      );
    }
  }

  getRuntime(): SidecarRuntime | null {
    return this.runtime;
  }

  protected async resetRuntime(): Promise<void> {
    this.cancelIdleTimer();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      this.stoppingChildren.add(runtime.child);
      await runtime.child.kill().catch(() => {});
    }
  }

  protected markActivity(): void {
    if (this.config.idleDisposeMs == null || !this.runtime) {
      return;
    }

    if (this.activityLeaseCount > 0) {
      return;
    }

    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      getLogger().info(
        `[${this.config.logPrefix}] idle for ${this.config.idleDisposeMs}ms, disposing to free resources`,
      );
      void this.dispose().catch((error) => {
        getLogger().warning(
          `[${this.config.logPrefix}] idle dispose failed: ${toErrorMessage(error)}`,
        );
      });
    }, this.config.idleDisposeMs);
  }

  /**
   * Pins the sidecar process while at least one lease is held: the idle
   * dispose timer is cancelled and cannot be rescheduled until every lease is
   * released. Streaming sessions use this so a >60s speech pause can never
   * let the idle-dispose kill the process under an open session.
   *
   * Returns the release function (safe to call multiple times).
   */
  protected beginActivityLease(): () => void {
    this.activityLeaseCount += 1;
    this.cancelIdleTimer();

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.activityLeaseCount = Math.max(0, this.activityLeaseCount - 1);
      // Re-arm the idle clock from the moment the last lease drops.
      if (this.activityLeaseCount === 0 && this.runtime) {
        this.markActivity();
      }
    };

    return release;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  protected abstract buildSpawnEnv(): Promise<Record<string, string>>;
  /** Optional working directory for the spawned sidecar. Used on Windows to
   * point the child's DLL search at the bundled sherpa-onnx runtime folder. */
  protected buildSpawnCwd(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  protected abstract parsePortFromLine(line: string): number | null;
  protected abstract handleStdoutLine(
    line: string,
    child: ShellChildProcess,
  ): void;
  protected abstract onStarted(runtime: SidecarRuntime): void;
  protected abstract onStopped(): void;
  protected abstract onError(message: string): void;
  protected abstract checkHealthResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<boolean>;

  private async startInternal(signal: AbortSignal): Promise<SidecarRuntime> {
    this.onStarting();

    const env = await this.buildSpawnEnv();
    if (signal.aborted) throw signal.reason;
    const cwd = await this.buildSpawnCwd();
    if (signal.aborted) throw signal.reason;
    const ready = createDeferred<number>();
    // Shell events can arrive before the asynchronous spawn call resolves.
    // Observe an early rejection now; waitForPort still receives the original promise.
    void ready.promise.catch(() => {});
    const pendingStdoutLines: string[] = [];
    let stdoutBuffer = "";
    let childPid = -1;
    let child: ShellChildProcess | null = null;
    let startupError: Error | null = null;
    let cleaningUp = false;
    let started = false;
    const retired = () =>
      signal.aborted ||
      cleaningUp ||
      (child !== null && this.stoppingChildren.has(child));

    const failReady = (message: string) => {
      startupError = new Error(message);
      ready.reject(startupError);
    };

    child = await spawnShellSidecar({
      program: this.config.binaryName,
      options: { env, ...(cwd ? { cwd } : {}) },
      onStdout: (chunk) => {
        if (retired()) return;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!child) {
            pendingStdoutLines.push(line);
            continue;
          }

          this.processStdoutLine(line, child, ready);
        }
      },
      onStderr: (chunk) => {
        if (retired()) return;
        getLogger().warning(
          `[${this.config.logPrefix}:${childPid}] ${chunk.trimEnd()}`,
        );
      },
      onClose: (payload) => {
        if (retired()) return;
        if (started && this.runtime?.child !== child) return;
        if (started) this.runtime = null;

        const message =
          `Sidecar exited (code=${payload.code ?? "unknown"}, ` +
          `signal=${payload.signal ?? "unknown"})`;
        getLogger().warning(`[${this.config.logPrefix}] ${message}`);
        if (started) this.onError(message);
        else failReady(message);
      },
      onError: (message) => {
        if (retired()) return;
        getLogger().warning(`[${this.config.logPrefix}] ${message}`);
        failReady(`Sidecar failed before startup completed: ${message}`);
      },
    });
    childPid = child.pid;

    let port: number;
    let baseUrl: string;
    try {
      if (signal.aborted) throw signal.reason;
      for (const line of pendingStdoutLines) {
        this.processStdoutLine(line, child, ready);
      }
      port = await this.waitForPort(ready.promise, signal);
      baseUrl = `http://${this.config.host}:${port}`;
      const assertStartupHealthy = () => {
        if (signal.aborted) throw signal.reason;
        if (startupError) throw startupError;
      };
      await this.waitUntilHealthy(baseUrl, signal, assertStartupHealthy);
      assertStartupHealthy();
    } catch (error) {
      cleaningUp = true;
      await child.kill().catch(() => {});
      throw error;
    }

    const runtime: SidecarRuntime = { port, baseUrl, child };
    this.runtime = runtime;
    started = true;
    this.onStarted(runtime);

    getLogger().info(
      `[${this.config.logPrefix}] started (pid=${child.pid}, port=${port})`,
    );

    return runtime;
  }

  protected onStarting(): void {}

  private processStdoutLine(
    line: string,
    child: ShellChildProcess,
    ready: import("./sidecar.utils").Deferred<number>,
  ) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const port = this.parsePortFromLine(trimmed);
    if (port !== null) {
      ready.resolve(port);
      return;
    }

    this.handleStdoutLine(trimmed, child);
  }

  private async waitForPort(
    portPromise: Promise<number>,
    signal: AbortSignal,
  ): Promise<number> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(`Timed out waiting for ${this.config.logPrefix} readiness`),
        );
      }, this.config.startupTimeoutMs);
    });

    try {
      return await raceWithAbort(
        Promise.race([portPromise, timeoutPromise]),
        signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitUntilHealthy(
    baseUrl: string,
    signal: AbortSignal,
    assertStartupHealthy: () => void,
  ): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs;

    // The probe is one at a time on purpose: each is spaced by the poll
    // interval and the loop ends on the first healthy answer, so the health
    // endpoint is asked at a fixed rate rather than in a burst. Recursion says
    // that outright, where an await in a loop reads as work that could overlap.
    const probe = async (): Promise<boolean> => {
      assertStartupHealthy();
      if (Date.now() >= deadline) {
        return false;
      }
      if (await this.checkHealth(baseUrl, signal)) {
        return true;
      }
      await sleep(this.config.healthPollIntervalMs);
      return probe();
    };

    if (await probe()) {
      return;
    }

    throw new Error(`Timed out waiting for ${this.config.logPrefix} health`);
  }

  private async readHealthResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<boolean> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Sidecar health response timed out")),
      this.config.healthTimeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      return await raceWithAbort(
        this.checkHealthResponse(response, controller.signal),
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      // Health responses are never returned to callers, regardless of whether
      // parsing succeeded, failed or was retired by a deadline.
      discardResponseBody(response);
    }
  }

  private async checkHealth(
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/health`,
        { signal },
        this.config.healthTimeoutMs,
      );
      if (!response.ok) {
        discardResponseBody(response);
        return false;
      }

      return await this.readHealthResponse(response, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      return false;
    }
  }
}
