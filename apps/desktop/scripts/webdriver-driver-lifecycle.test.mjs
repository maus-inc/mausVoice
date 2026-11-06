import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const { spawn, children } = vi.hoisted(() => ({
  spawn: vi.fn(),
  children: [],
}));
vi.mock("child_process", () => ({ spawn }));
import { config } from "../webdriver/wdio.conf.js";

afterEach(() => {
  config.afterSession();
  vi.restoreAllMocks();
  spawn.mockReset();
  children.length = 0;
});

it.skipIf(process.platform === "darwin")(
  "retired driver exit cannot hide a successor driver failure",
  () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        return true;
      });
      children.push(child);
      return child;
    });

    config.beforeSession();
    config.afterSession();
    expect(children[0].kill).toHaveBeenCalledOnce();
    config.beforeSession();
    children[0].emit("exit", null, "SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    children[1].emit("exit", 1, null);
    expect(exit).toHaveBeenCalledWith(1);
    config.afterSession();
  },
);

it.skipIf(process.platform === "darwin")(
  "treats an unexpected clean driver exit as a failure",
  () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        return true;
      });
      children.push(child);
      return child;
    });
    config.beforeSession();
    children[0].emit("exit", 0, null);
    expect(exit).toHaveBeenCalledWith(1);
  },
);
