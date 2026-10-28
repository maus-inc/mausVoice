// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";
import { LocalDailyActivityRepo } from "./daily-activity.repo";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

describe("LocalDailyActivityRepo", () => {
  beforeEach(() => {
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    invokeMock.mockReset();
  });

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

  it("blocks the backfill command during a local-data clear", async () => {
    const releaseClear = await beginLocalDataClear();

    try {
      await expect(
        new LocalDailyActivityRepo().listDailyActivity(
          "2026-01-04",
          "2026-09-01",
        ),
      ).rejects.toThrow("Local data is being cleared.");
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }
  });
});
