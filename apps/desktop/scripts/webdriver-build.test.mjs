import { describe, expect, it, vi } from "vitest";
import { runCheckedProcess } from "../webdriver/checked-process.js";

const command = "/node";
const args = ["/npm-cli.js", "run", "tauri", "build"];
const options = { cwd: "/project", stdio: "inherit" };

describe("webdriver build result ownership", () => {
  it("preserves the exact executable and arguments without a shell", () => {
    const result = { status: 0, signal: null };
    const spawn = vi.fn(() => result);
    expect(runCheckedProcess(command, args, options, spawn)).toBe(result);
    expect(spawn).toHaveBeenCalledWith(command, args, options);
  });

  it("rejects failed builds even when a previous build artifact exists", () => {
    const spawn = vi.fn(() => ({ status: 1, signal: null }));
    expect(() => runCheckedProcess(command, args, options, spawn)).toThrow(
      /status 1/,
    );
  });

  it("does not mistake a signal or spawn failure for success", () => {
    expect(() =>
      runCheckedProcess(command, args, options, () => ({
        status: null,
        signal: "SIGTERM",
      })),
    ).toThrow(/SIGTERM/);
    expect(() =>
      runCheckedProcess(command, args, options, () => ({
        status: null,
        error: new Error("ENOENT"),
      })),
    ).toThrow(/ENOENT/);
  });
});
