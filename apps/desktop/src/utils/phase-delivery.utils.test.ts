import { expect, it, vi } from "vitest";

const warning = vi.hoisted(() => vi.fn());
vi.mock("./log.utils", () => ({ getLogger: () => ({ warning }) }));
import { sendPhaseWithoutWaiting } from "./phase-delivery.utils";

it("observes synchronous and asynchronous phase failures without logging their contents", async () => {
  sendPhaseWithoutWaiting(() => {
    throw new Error("private phase detail");
  }, "idle");
  sendPhaseWithoutWaiting(
    () => Promise.reject(new Error("private phase detail")),
    "loading",
  );
  await Promise.resolve();
  expect(warning).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "private phase detail",
  );
});
