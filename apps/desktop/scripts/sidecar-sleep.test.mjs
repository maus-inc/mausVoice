import { describe, expect, it, vi } from "vitest";
import { sleepSync } from "./sidecar-sleep.mjs";

describe("sidecar retry backoff", () => {
  it("uses the atomic wait without spawning a child", () => {
    const wait = vi.fn();
    const spawn = vi.fn();
    sleepSync(25, { wait, spawn });
    expect(wait).toHaveBeenCalledExactlyOnceWith(25);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("falls back to a child with the delay passed as data", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    sleepSync(25, {
      wait: () => {
        throw new Error("unavailable");
      },
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual([
      "-e",
      "setTimeout(()=>{}, Number(process.argv[1]))",
      "25",
    ]);
  });
  it("retries child sleep and finally uses a monotonic clock", () => {
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => ({ error: { code: "EAGAIN" } }))
      .mockImplementationOnce(() => {
        throw new Error("unavailable");
      });
    const now = vi
      .fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(35);
    const warn = vi.fn();
    sleepSync(25, {
      wait: () => {
        throw new Error("unavailable");
      },
      spawn,
      now,
      warn,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("EAGAIN");
  });
  it("rejects invalid delays before executing any wait", () => {
    const wait = vi.fn();
    for (const delay of [-1, Infinity, NaN, "1; throw new Error()"])
      expect(() => sleepSync(delay, { wait })).toThrow();
    expect(wait).not.toHaveBeenCalled();
  });
});
