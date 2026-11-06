import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTemporaryIconFiles } from "../../../scripts/icon-temporary-files.mjs";

describe("icon generation temporary files", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "icon-frame-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("removes every frame after a successful generation", () => {
    const first = join(root, "a.png");
    const second = join(root, "b.png");
    const result = withTemporaryIconFiles((track) => {
      writeFileSync(track(first), "a");
      writeFileSync(track(second), "b");
      return "done";
    });
    expect(result).toBe("done");
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("removes a partially written frame if rendering throws", () => {
    const frame = join(root, "partial.png");
    expect(() =>
      withTemporaryIconFiles((track) => {
        writeFileSync(track(frame), "partial");
        throw new Error("renderer failed");
      }),
    ).toThrow("renderer failed");
    expect(existsSync(frame)).toBe(false);
  });

  it("attempts every cleanup and preserves the generation failure", () => {
    const remove = vi.fn((path) => {
      if (path === "a") throw new Error("remove failed");
    });
    expect(() =>
      withTemporaryIconFiles((track) => {
        track("a");
        track("b");
        throw new Error("renderer failed");
      }, remove),
    ).toThrow(/renderer failed/);
    expect(remove.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("reports cleanup errors even after a successful generation", () => {
    expect(() =>
      withTemporaryIconFiles(
        (track) => track("a"),
        () => {
          throw new Error("remove failed");
        },
      ),
    ).toThrow(/remove failed/);
  });
});
