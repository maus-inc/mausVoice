import { expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../webdriver/checked-process.js", () => ({ runCheckedProcess: run }));
import { config } from "../webdriver/wdio.conf.js";

it("does not start a driver or use an old build when the build command fails", async () => {
  run.mockImplementation(() => {
    throw new Error("build failed");
  });
  await expect(config.onPrepare()).rejects.toThrow("build failed");
  expect(run).toHaveBeenCalledOnce();
});
