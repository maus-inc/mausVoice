import { test } from "node:test";
import assert from "node:assert/strict";
import { autoReleaseNotes } from "./auto-release-notes.mjs";

test("selects the latest reachable previous tag and summarizes commits", () => {
  const calls = [];
  const run = (program, args) => {
    calls.push([program, args]);
    return calls.length === 1
      ? { status: 0, stdout: "mausVoice-v2.0.0\nmausVoice-v1.0.0\n" }
      : { status: 0, stdout: "feat(ui): Improve labels\nfix: Repair layout\n" };
  };
  assert.equal(
    autoReleaseNotes("mausVoice-v2.0.0", run),
    "- Improve labels\n- Repair layout",
  );
  assert.ok(calls[0][1].includes("--merged=HEAD"));
  assert.deepEqual(calls[1][1], [
    "log",
    "mausVoice-v1.0.0..HEAD",
    "--no-merges",
    "--format=%s",
  ]);
});

test("uses HEAD when no earlier release is reachable", () => {
  const calls = [];
  const run = (_program, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: calls.length === 1 ? "mausVoice-v1.0.0\n" : "Initial commit\n",
    };
  };
  assert.equal(autoReleaseNotes("mausVoice-v1.0.0", run), "- Initial commit");
  assert.equal(calls[1][1], "HEAD");
});

test("falls back without using partial output when either git command fails", () => {
  let calls = 0;
  assert.equal(
    autoReleaseNotes("", () => {
      calls++;
      return { status: 1, stdout: "mausVoice-v1.0.0" };
    }),
    null,
  );
  assert.equal(calls, 1);
  assert.equal(
    autoReleaseNotes("", () =>
      ++calls === 2
        ? { status: 0, stdout: "" }
        : { status: 1, stdout: "partial log" },
    ),
    null,
  );
  assert.equal(
    autoReleaseNotes("", () => ({
      status: null,
      error: new Error("missing git"),
    })),
    null,
  );
  assert.equal(
    autoReleaseNotes("", () => {
      throw new Error("spawn failed");
    }),
    null,
  );
});
