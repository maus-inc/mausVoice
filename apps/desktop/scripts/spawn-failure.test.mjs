import { describe, expect, it } from "vitest";
import { describeSpawnFailure } from "./spawn-failure.mjs";

describe("describeSpawnFailure", () => {
  it.each([
    [undefined, "unknown"],
    [{ status: 23 }, "23"],
    [{ status: 0 }, "0"],
    [{ signal: "SIGTERM" }, "signal:SIGTERM — killed by signal SIGTERM"],
    [{ error: { code: "ENOENT", message: "missing" } }, "ENOENT — missing"],
    [{ error: { message: "missing" } }, "missing"],
    [
      { error: { code: "ENOENT" }, signal: "SIGTERM" },
      "ENOENT — killed by signal SIGTERM",
    ],
    [
      { error: { message: "missing" }, signal: "SIGTERM" },
      "missing — killed by signal SIGTERM",
    ],
  ])("formats %j", (result, expected) => {
    expect(describeSpawnFailure(result)).toBe(expected);
  });
});
