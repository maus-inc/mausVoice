import { describe, expect, it, vi } from "vitest";
import { LocalDailyActivityRepo } from "./daily-activity.repo";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

describe("LocalDailyActivityRepo", () => {
  it("requests inclusive local-date totals from the native repository", async () => {
    const expected = [{ localDate: "2026-09-01", wordCount: 420 }];
    invokeMock.mockResolvedValueOnce(expected);

    const result = await new LocalDailyActivityRepo().listDailyActivity(
      "2026-01-04",
      "2026-09-01",
    );

    expect(invokeMock).toHaveBeenCalledWith("daily_activity_list", {
      startDate: "2026-01-04",
      endDate: "2026-09-01",
    });
    expect(result).toEqual(expected);
  });
});
