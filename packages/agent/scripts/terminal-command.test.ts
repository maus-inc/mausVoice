import { expect, it, vi } from "vitest";
import { runConfirmedCommand } from "./terminal-command";

it("never executes a denied command", async () => {
  const run = vi.fn();
  const confirm = vi.fn(async () => false);
  await expect(
    runConfirmedCommand("echo unsafe", "test reason", confirm, run),
  ).resolves.toEqual({
    success: false,
    failureReason: "User denied the command.",
  });
  expect(confirm).toHaveBeenCalledWith(
    'Execute "echo unsafe"?\n  Reason: test reason',
  );
  expect(run).not.toHaveBeenCalled();
});

it("returns trimmed output from a time-limited approved command", async () => {
  const run = vi.fn(async () => ({ stdout: " ok\n", stderr: " warning\n" }));
  await expect(
    runConfirmedCommand("echo ok", "reason", async () => true, run),
  ).resolves.toEqual({
    success: true,
    result: { stdout: "ok", stderr: "warning", exitCode: 0 },
  });
  expect(run).toHaveBeenCalledWith("echo ok", { timeout: 30000 });
});

it.each([
  [{ stderr: " details \n", message: "fallback" }, "details"],
  [{ stderr: " \n", message: "fallback" }, "fallback"],
  [null, "Command failed"],
])(
  "retains useful failures even when stderr is empty",
  async (error, expected) => {
    const run = vi.fn(async () => {
      throw error;
    });
    await expect(
      runConfirmedCommand("false", "reason", async () => true, run),
    ).resolves.toEqual({ success: false, failureReason: expected });
  },
);
