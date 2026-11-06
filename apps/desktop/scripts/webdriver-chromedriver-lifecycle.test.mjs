import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const { spawn, wait, preview, run } = vi.hoisted(() => ({
  spawn: vi.fn(),
  wait: vi.fn(),
  preview: vi.fn(),
  run: vi.fn(),
}));
vi.mock("child_process", () => ({ spawn }));
vi.mock("chromedriver", () => ({ default: { path: "/chromedriver" } }));
vi.mock("vite", () => ({ preview }));
vi.mock("../webdriver/wait-for-http-server.js", () => ({
  waitForHttpServer: wait,
}));
vi.mock("../webdriver/checked-process.js", () => ({ runCheckedProcess: run }));

async function macConfig() {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  try {
    return (await import("../webdriver/wdio.conf.js")).config;
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

it("a retired ChromeDriver cannot clear the next session's driver", async () => {
  const config = await macConfig();
  const children = [];
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    children.push(child);
    return child;
  });
  wait.mockResolvedValue(undefined);
  preview.mockImplementation(async () => ({
    httpServer: { listening: true },
    close: vi.fn().mockResolvedValue(undefined),
  }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await config.onPrepare();
    config.afterSession();
    expect(children[0].kill).toHaveBeenCalledOnce();
    await config.onPrepare();
    children[0].emit("exit", null, "SIGTERM");
    expect(log).not.toHaveBeenCalled();
    config.afterSession();
    expect(children[1].kill).toHaveBeenCalledOnce();
  } finally {
    config.afterSession();
    log.mockRestore();
  }
});

it("cancels ChromeDriver readiness when the owned process is retired", async () => {
  const config = await macConfig();
  let child;
  spawn.mockImplementation(() => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    return child;
  });
  let signal;
  wait.mockImplementation((options) => {
    signal = options.signal;
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  preview.mockClear();
  const pending = config.onPrepare();
  const rejected = pending.then(
    () => null,
    (error) => error,
  );
  try {
    expect(signal).toBeDefined();
    config.afterSession();
    expect(signal.aborted).toBe(true);
    expect(await rejected).toBeInstanceOf(Error);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();
  } finally {
    config.afterSession();
  }
});

it("fails readiness immediately when ChromeDriver emits an error", async () => {
  const config = await macConfig();
  let child;
  spawn.mockImplementation(() => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    return child;
  });
  wait.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  preview.mockClear();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("driver could not start");
  try {
    const pending = config.onPrepare();
    const rejected = expect(pending).rejects.toBe(failure);
    child.emit("error", failure);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();
  } finally {
    config.afterSession();
    log.mockRestore();
  }
});

it("coalesces concurrent preparation until ChromeDriver is ready", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  spawn.mockReset().mockReturnValue(child);
  run.mockReset();
  preview.mockReset().mockImplementation(async () => ({
    httpServer: { listening: true },
    close: vi.fn().mockResolvedValue(undefined),
  }));
  let ready;
  wait.mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  try {
    const first = config.onPrepare();
    const second = config.onPrepare();
    await Promise.resolve();
    await Promise.resolve();
    expect(preview).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    ready();
    await Promise.all([first, second]);
    expect(preview).toHaveBeenCalledOnce();
  } finally {
    config.afterSession();
  }
});

it("retires an in-flight preview and closes a server that appears late", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  spawn.mockReset().mockReturnValue(child);
  wait.mockReset().mockResolvedValue(undefined);
  let created;
  preview.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        created = resolve;
      }),
  );
  const server = {
    httpServer: { listening: true },
    close: vi.fn().mockResolvedValue(undefined),
  };
  const pending = config.onPrepare();
  // Preview creation starts after the ChromeDriver readiness microtask.
  await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
  const rejected = expect(pending).rejects.toThrow(/retired/i);
  config.afterSession();
  await rejected; // Does not depend on Vite completing creation.
  created(server);
  await Promise.resolve();
  expect(server.close).toHaveBeenCalledOnce();
});

it("retires a preview while waiting for its listener without leaving handlers", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  spawn.mockReset().mockReturnValue(child);
  wait.mockReset().mockResolvedValue(undefined);
  const httpServer = new EventEmitter();
  httpServer.listening = false;
  const server = { httpServer, close: vi.fn().mockResolvedValue(undefined) };
  preview.mockReset().mockResolvedValue(server);
  const pending = config.onPrepare();
  await vi.waitFor(() => expect(httpServer.listenerCount("listening")).toBe(1));
  const rejected = expect(pending).rejects.toThrow(/retired/i);
  config.afterSession();
  await rejected;
  expect(server.close).toHaveBeenCalledOnce();
  expect(httpServer.listenerCount("listening")).toBe(0);
  expect(httpServer.listenerCount("error")).toBe(0);
});

it("closes a preview when its listener errors", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  spawn.mockReset().mockReturnValue(child);
  wait.mockReset().mockResolvedValue(undefined);
  const httpServer = new EventEmitter();
  httpServer.listening = false;
  const server = { httpServer, close: vi.fn().mockResolvedValue(undefined) };
  preview.mockReset().mockResolvedValue(server);
  const pending = config.onPrepare();
  await vi.waitFor(() => expect(httpServer.listenerCount("error")).toBe(1));
  const error = new Error("port unavailable");
  const rejected = expect(pending).rejects.toBe(error);
  httpServer.emit("error", error);
  await rejected;
  expect(server.close).toHaveBeenCalledOnce();
  expect(httpServer.listenerCount("listening")).toBe(0);
  expect(httpServer.listenerCount("error")).toBe(0);
  expect(child.kill).toHaveBeenCalledOnce();
  config.afterSession();
});

it("fails preparation if the ready ChromeDriver exits before preview creation", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  spawn.mockReset().mockReturnValue(child);
  wait.mockReset().mockResolvedValue(undefined);
  let created;
  preview.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        created = resolve;
      }),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const pending = config.onPrepare();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    const rejected = expect(pending).rejects.toThrow(/ChromeDriver exited/);
    child.emit("exit", 1);
    await rejected;
    const server = {
      httpServer: { listening: true },
      close: vi.fn().mockResolvedValue(undefined),
    };
    created(server);
    await Promise.resolve();
    expect(server.close).toHaveBeenCalledOnce();
  } finally {
    config.afterSession();
    log.mockRestore();
  }
});

it("fails readiness immediately when ChromeDriver exits", async () => {
  const config = await macConfig();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn();
  spawn.mockReset().mockReturnValue(child);
  wait.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  preview.mockClear();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const pending = config.onPrepare();
    const rejected = expect(pending).rejects.toThrow(/ChromeDriver exited/);
    child.emit("exit", 0);
    await rejected;
    expect(preview).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    config.afterSession();
    log.mockRestore();
  }
});

it("allows a fresh preparation after preview startup fails", async () => {
  const config = await macConfig();
  const children = [];
  spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    children.push(child);
    return child;
  });
  wait.mockReset().mockResolvedValue(undefined);
  const failure = new Error("preview creation failed");
  preview
    .mockReset()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({
      httpServer: { listening: true },
      close: vi.fn().mockResolvedValue(undefined),
    });
  try {
    await expect(config.onPrepare()).rejects.toBe(failure);
    expect(children[0].kill).toHaveBeenCalledOnce();
    await config.onPrepare();
    expect(children).toHaveLength(2);
    expect(preview).toHaveBeenCalledTimes(2);
  } finally {
    config.afterSession();
  }
});
