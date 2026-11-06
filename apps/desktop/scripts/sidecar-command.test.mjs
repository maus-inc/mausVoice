import { describe, expect, it, vi } from "vitest";
import { runSidecarCommand } from "./sidecar-command.mjs";

describe("sidecar build command execution", () => {
  it("returns success only for a successful child and preserves argv", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const fail = vi.fn();
    expect(
      runSidecarCommand(
        "cargo",
        ["build", "--locked"],
        "/repo",
        {},
        { spawn, fail },
      ),
    ).toBe(true);
    expect(spawn).toHaveBeenCalledWith("cargo", ["build", "--locked"], {
      cwd: "/repo",
      stdio: "inherit",
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("reports an unavailable executable and preserves its message", () => {
    const spawn = vi.fn(() => ({
      status: null,
      error: Object.assign(new Error("cargo missing"), { code: "ENOENT" }),
    }));
    const warn = vi.fn();
    expect(
      runSidecarCommand(
        "cargo",
        [],
        "/repo",
        { allowFailure: true },
        { spawn, warn },
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/ENOENT.*cargo missing/),
    );
  });

  it("does not treat a child error as success even with a zero status", () => {
    const spawn = vi.fn(() => ({
      status: 0,
      error: new Error("child process failure"),
    }));
    const warn = vi.fn();
    expect(
      runSidecarCommand(
        "cargo",
        [],
        "/repo",
        { allowFailure: true },
        { spawn, warn },
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("child process failure"),
    );
  });

  it("reports signals and fails closed on required commands", () => {
    const spawn = vi.fn(() => ({ status: null, signal: "SIGKILL" }));
    const fail = vi.fn((message) => {
      throw new Error(message);
    });
    expect(() =>
      runSidecarCommand("cargo", [], "/repo", {}, { spawn, fail }),
    ).toThrow(/SIGKILL/);
  });

  it("reports synchronous spawn exceptions in optional commands", () => {
    const spawn = vi.fn(() => {
      throw new Error("spawn exploded");
    });
    const warn = vi.fn();
    expect(
      runSidecarCommand(
        "cargo",
        [],
        "/repo",
        { allowFailure: true },
        { spawn, warn },
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("spawn exploded"),
    );
  });
});
