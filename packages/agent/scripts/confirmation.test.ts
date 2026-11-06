import { describe, expect, it } from "vitest";
import { isExplicitConfirmation } from "./confirmation";

describe("terminal command confirmation", () => {
  it.each(["y", "yes", "Y", " YES "])(
    "accepts an explicit affirmative %j",
    (answer) => {
      expect(isExplicitConfirmation(answer)).toBe(true);
    },
  );
  it.each(["", " ", "n", "no", "maybe", "yeah", "yes please", "y\nn"])(
    "denies every other answer %j",
    (answer) => {
      expect(isExplicitConfirmation(answer)).toBe(false);
    },
  );
});

it("treats closed input as denial", async () => {
  const { PassThrough } = await import("node:stream");
  const { createInterface } = await import("node:readline");
  const { askForConfirmation } = await import("./confirmation");
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  const result = askForConfirmation(rl, "Run command?");
  input.end();
  await expect(result).resolves.toBe(false);
});

it("releases its close listener after a response", async () => {
  const { PassThrough } = await import("node:stream");
  const { createInterface } = await import("node:readline");
  const { askForConfirmation } = await import("./confirmation");
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  const before = rl.listenerCount("close");
  const result = askForConfirmation(rl, "Run command?");
  input.write("yes\n");
  await expect(result).resolves.toBe(true);
  expect(rl.listenerCount("close")).toBe(before);
  rl.close();
});
