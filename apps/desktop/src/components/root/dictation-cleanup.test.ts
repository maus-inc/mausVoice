import { expect, it, vi } from "vitest";

const warning = vi.hoisted(() => vi.fn());
vi.mock("../../utils/log.utils", () => ({ getLogger: () => ({ warning }) }));
import { releaseRecordingResource } from "./dictation-cleanup";

it("keeps cleanup moving when both a release and the log sink throw", () => {
  warning.mockImplementationOnce(() => {
    throw new Error("log failed");
  });
  const next = vi.fn();
  expect(() => {
    releaseRecordingResource("Timers", "during abort", () => {
      throw new Error("failed");
    });
    releaseRecordingResource("Native capture", "during abort", next);
  }).not.toThrow();
  expect(next).toHaveBeenCalledOnce();
});

it("observes asynchronous cleanup failures without throwing", async () => {
  warning.mockReset();
  releaseRecordingResource("Native capture", "during abort", () =>
    Promise.reject(new Error("failed")),
  );
  await vi.waitFor(() =>
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Native capture cleanup failed during abort"),
    ),
  );
});
