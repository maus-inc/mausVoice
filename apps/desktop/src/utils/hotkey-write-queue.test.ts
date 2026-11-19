import { expect, it } from "vitest";
import { enqueueHotkeyWrite } from "./hotkey-write-queue";

it("continues later shortcut writes after a rejected write", async () => {
  const first = enqueueHotkeyWrite(async () => {
    throw new Error("write failed");
  });
  const second = enqueueHotkeyWrite(async () => "saved");
  await expect(first).rejects.toThrow("write failed");
  await expect(second).resolves.toBe("saved");
});
